/**
 * The bridge: watches Claude Code sessions and writes normalized chunks.
 *
 * At this stage everything lands in a **local directory** — the relay sync is a
 * separate concern layered on top. That keeps this milestone verifiable on its
 * own: if events are wrong here, no amount of correct git plumbing will help.
 *
 * Reading is deliberately two-speed:
 *  - **Frequently**, every known transcript is stat-polled for growth. Windows
 *    file watching is unreliable for a file another process is appending to, so
 *    polling is the primary mechanism rather than the fallback.
 *  - **Occasionally**, the transcript tree is rescanned for new sessions and
 *    agents, which is comparatively expensive.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AttentionLevel,
  type EventDraft,
  type InjectionState,
  type NormalizedEvent,
  type RelayIndex,
  type RegistryEntry,
  type SessionHead,
  type SessionIndexEntry,
  type SessionState,
} from '@ccr/shared';

import { ChunkWriter, atomicWriteJson, type ChunkRange } from './chunker.js';
import { bootstrapConfig, type BridgeConfig } from './config.js';
import { readControlled } from './control.js';
import { sendControlMessage, type ControlledSession } from './control.js';
import {
  applyHookEvent,
  hookFacts,
  hooksCurrent,
  startHookServer,
  HOOK_PATH,
  type HookPayload,
  type HookServer,
  type HookSessionState,
} from './hooks.js';
import { parseInboundPrompt, verifyPrompt, type VerifyFailure } from './inbound.js';
import {
  injectionRefusal,
  isFreshSession,
  matchDeliveredTurn,
  type InjectionRefusal,
} from './inject.js';
import { RelaySync } from './sync.js';
import {
  readJson,
  readRegistry,
  scanAgents,
  scanProjects,
  type DiscoveredSession,
} from './discovery.js';
import { lockAgeMs, lockIsLive, lockPath, readLock } from './lock.js';
import { SerialQueue } from './queue.js';
import { advanceLastMainKind, resumeSeq, SessionAggregator } from './session.js';
import { isStopRequestFor, readStopRequest } from './stop-request.js';
import { Tailer, type TailState } from './tailer.js';

/**
 * The only events that justify a publish.
 *
 * A turn ending, a session blocking on input, and a prompt's fate are the
 * moments worth waking a phone for. Streaming prose is not: it would mean
 * publishing continuously through a long turn, and push frequency — not the
 * shape of the data — is what bounds how large the relay grows.
 */
const PUBLISH_TRIGGERS: ReadonlySet<string> = new Set(['turn_end', 'attention', 'injection']);

/**
 * How a refusal is worded for the phone.
 *
 * Refusals are read on a phone with no other context, and these three are the
 * ones a person will actually hit, so each says what to do about it. The bare
 * reason alone gives them nothing to act on.
 */
const REFUSAL_DETAIL: Partial<Record<InjectionRefusal, string>> = {
  'session-not-idle': 'session-not-idle: it is mid-turn. Send again once the turn finishes.',
  'permission-dialog-open':
    'permission-dialog-open: a permission prompt is waiting on the PC. Answer it there — typing here would answer it for you.',
  'tool-in-flight': 'tool-in-flight: a tool is still running on the PC. Send again when it finishes.',
};

/**
 * Hook sessions tracked at once.
 *
 * Hooks fire for every session on the machine, including ones the relay will
 * never publish, so this cannot grow without bound. Past the cap the least
 * recently heard-from session is dropped; losing its state only means falling
 * back to the transcript rule until its next event.
 */
const MAX_HOOK_SESSIONS = 200;

interface PersistedState {
  version: 1;
  tails: Record<string, TailState>;
  sessions: Record<
    string,
    {
      seq: number;
      /**
       * Kind of the last main-thread event, persisted across restarts.
       *
       * The injection guard reads this, so losing it is not cosmetic: on a
       * restart the bridge replays nothing for a session whose transcript has
       * not changed since, leaving this null and the guard refusing every
       * prompt until that session happens to emit something new.
       */
      lastMainKind?: string | null;
    }
  >;
  /**
   * Prompts already evaluated, so a rejected one is reported once rather than
   * on every poll. They are deliberately not deleted — see `#pollInbound`.
   */
  seenPrompts: string[];
}

interface AgentRuntime {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
  tailer: Tailer;
  metaLoaded: boolean;
}

interface SessionRuntime {
  sessionId: string;
  discovered: DiscoveredSession;
  tailer: Tailer;
  aggregator: SessionAggregator;
  chunker: ChunkWriter;
  /**
   * Serialises everything that allocates a sequence number or appends a chunk.
   *
   * Sequencing lives in the aggregator, so "take the next number" and "write the
   * event" have to happen as one step. Without this, an event recorded while a
   * batch is being appended is written ahead of numbers already handed out to
   * that batch — see `SerialQueue`.
   */
  queue: SerialQueue;
  agents: Map<string, AgentRuntime>;
  stateDirty: boolean;
  /** Agents appear throughout a session's life, so discovery is re-run. */
  lastAgentScan: number;
  /**
   * Kind of the most recent event from the *main thread*.
   *
   * Used to decide whether a prompt can safely be typed in. Subagent events are
   * excluded deliberately: they arrive on independent schedules and would
   * otherwise make the main thread look busy, or idle, at random.
   */
  lastMainKind: string | null;
  /**
   * Timestamp of the newest main-thread event read from this session's
   * transcript, or 0.
   *
   * Compared against the last hook event to notice that hooks have stopped
   * delivering: if the transcript keeps moving and the hook stream does not,
   * something is being missed, and the guard must stop trusting it. Taken from
   * the event's own timestamp rather than from when it was read, so a cold-start
   * replay of old lines cannot look like fresh activity.
   */
  lastMainEventAt: number;
}

/**
 * What the bridge needs from whoever owns its lifetime.
 *
 * The bridge does not exit on its own: honouring a stop request means finishing
 * the work in flight, not calling `process.exit` from inside a tick, and a
 * process that ends itself is a process no test can hold still.
 */
export interface BridgeOptions {
  /**
   * Called once when a `ccr` session has asked this bridge to stop.
   *
   * The owner is expected to run `stop()` and then exit.
   */
  onStopRequested?: (reason: string) => void;
}

export class Bridge {
  readonly #config: BridgeConfig;
  readonly #options: BridgeOptions;
  #sessions = new Map<string, SessionRuntime>();
  #registry = new Map<string, RegistryEntry>();
  #persisted: PersistedState = { version: 1, tails: {}, sessions: {}, seenPrompts: [] };
  #timers: NodeJS.Timeout[] = [];
  #running = false;
  #lastIndexWrite = 0;
  #relay: RelaySync | null = null;
  #relayDirty = false;
  #seenPrompts = new Set<string>();
  /** Sessions launched through `ccr`, by pid, refreshed with the registry. */
  #controlledPids = new Map<number, ControlledSession>();
  #publishTimer: NodeJS.Timeout | null = null;
  /**
   * The publish currently running, if any.
   *
   * Kept as the promise rather than a boolean so shutdown can *wait* for one
   * instead of racing it — the last publish of a process is the one that carries
   * the session's ending, and losing that race leaves the phone reading `active`
   * from a relay nothing will ever correct.
   */
  #publishInFlight: Promise<void> | null = null;
  /** A stop request has been seen and handed on; do not hand it on twice. */
  #honouringStop = false;
  /**
   * Prompts typed into a session, awaiting evidence that they landed.
   *
   * Typing into a terminal is not delivery: Claude Code queues input mid-turn
   * and can discard what it queued, so the only proof a prompt arrived is it
   * appearing as a turn in the transcript. Until then the honest word is
   * "typed", not "delivered".
   */
  #awaitingDelivery = new Map<string, { promptId: string; text: string; at: number }[]>();
  /** A trigger arrived while a publish was already running. */
  #republish = false;
  /**
   * What hooks have reported, per session.
   *
   * Keyed by session id and kept whether or not the relay knows the session:
   * events arrive for sessions the bridge has not discovered yet, and the state
   * has to be there when it does.
   */
  #hookState = new Map<string, HookSessionState>();
  /** The hook receiver, or null when it could not start. */
  #hooks: HookServer | null = null;

  constructor(config: BridgeConfig, options: BridgeOptions = {}) {
    this.#config = config;
    this.#options = options;
  }

  get sessions(): ReadonlyMap<string, SessionRuntime> {
    return this.#sessions;
  }

  async start(): Promise<void> {
    await mkdir(this.#config.outDir, { recursive: true });
    await mkdir(this.#config.stateDir, { recursive: true });
    await this.#acquireLock();

    this.#running = true;
    await this.#loadPersisted();

    await this.#rescan();
    await this.#tick();

    await this.#startRelay();
    await this.#startHooks();

    this.#timers.push(
      setInterval(() => {
        void this.#tick();
      }, this.#config.pollFilesMs),
      setInterval(() => {
        void this.#rescan();
      }, this.#config.rescanMs),
      setInterval(() => {
        void this.#refreshRegistry();
      }, Math.max(1_000, this.#config.rescanMs)),
      setInterval(() => {
        void this.#persist();
      }, 5_000),
      // Well inside the stale window, so a busy event loop cannot make us look
      // dead to a newcomer.
      setInterval(() => {
        void this.#heartbeat();
      }, Math.max(1_000, Math.floor(this.#config.lockStaleMs / 4))),
    );

    if (this.#relay) {
      // No periodic publish. Publishing is driven by turn boundaries and
      // attention signals; a timer would push continuously during a long turn
      // for no benefit the reader can see, and push frequency is what bounds
      // repository growth. See docs/RELAY-DESIGN.md.
      this.#timers.push(
        setInterval(() => {
          void this.#pollInbound();
        }, this.#config.pollIntervalMs),
      );
    }
  }

  /**
   * Start the hook receiver, if the port is free.
   *
   * A port already in use is not a failure worth stopping for: everything still
   * works, the guard simply falls back to the transcript rule for every session,
   * which is exactly what it did before hooks existed. Refusing to start would
   * be a worse answer to a missing convenience.
   */
  async #startHooks(): Promise<void> {
    const log = (message: string): void => {
      process.stderr.write(`[hooks] ${message}\n`);
    };

    if (this.#config.hookToken === null) {
      // Not fatal, but worth one line: an unauthenticated loopback endpoint
      // lets any local process forge a `Stop` and clear the dialog flag.
      log('no CCR_HOOK_TOKEN configured; accepting any request from this machine');
    }

    try {
      this.#hooks = await startHookServer({
        port: this.#config.hookPort,
        token: this.#config.hookToken,
        onEvent: (payload) => this.#onHookEvent(payload),
        log,
      });
      log(`listening on http://127.0.0.1:${this.#config.hookPort}${HOOK_PATH}`);
    } catch (error) {
      this.#hooks = null;
      log(
        `unavailable on port ${this.#config.hookPort} (${String(error)}); ` +
          'continuing without them, so the transcript rule decides',
      );
    }
  }

  /**
   * Fold one hook event in, and surface what the phone should know.
   *
   * Synchronous on purpose: a hook is waiting on this response, and holding it
   * open would slow the PC down for nothing.
   */
  #onHookEvent(payload: HookPayload): void {
    const previous = this.#hookState.get(payload.sessionId);
    const { state, attention } = applyHookEvent(previous, payload, Date.now());
    this.#hookState.set(payload.sessionId, state);
    this.#trimHookState();

    if (!previous?.hooksLive) {
      process.stderr.write(
        `[hooks] ${payload.sessionId}: ${payload.eventName} (first event for this session)\n`,
      );
    }

    if (!attention) return;
    process.stderr.write(`[hooks] ${payload.sessionId}: ${attention.text}\n`);

    // The state stands whether or not the relay knows this session; only the
    // timeline entry needs somewhere to go.
    const runtime = this.#sessions.get(payload.sessionId);
    if (!runtime) return;
    void this.#recordAttention(runtime, attention.text, attention.level).catch(() => {});
  }

  #trimHookState(): void {
    if (this.#hookState.size <= MAX_HOOK_SESSIONS) return;

    const oldest = [...this.#hookState.entries()]
      .sort((a, b) => a[1].lastEventAt - b[1].lastEventAt)
      .slice(0, this.#hookState.size - MAX_HOOK_SESSIONS);
    for (const [sessionId] of oldest) this.#hookState.delete(sessionId);
  }

  /**
   * Whether hook state for a session may be believed over the transcript.
   *
   * Three ways it may not be, all of which fall back to the transcript rule
   * unchanged: no receiver is listening, no hook has ever reported for this
   * session, or the transcript has moved on while the hook stream has not — in
   * which case events are being missed and the state is stale in an unknown
   * direction.
   */
  #hooksTrusted(sessionId: string, runtime: SessionRuntime | undefined): boolean {
    if (!this.#hooks?.running) return false;
    return hooksCurrent(
      this.#hookState.get(sessionId),
      runtime?.lastMainEventAt ?? 0,
      this.#config.hookQuietMs,
    );
  }

  /**
   * Coalesce a publish.
   *
   * Turn boundaries arrive in bursts — a session can end several turns in quick
   * succession — and each publish rewrites the branch. This collapses them into
   * one, and the floor is a minimum gap rather than an interval: nothing is
   * published unless something actually asked for it.
   */
  #schedulePublish(): void {
    // A timer set during shutdown would outlive the lock it is publishing under,
    // and fire against a relay this process has already finished with.
    if (!this.#running || !this.#relay || this.#publishTimer) return;
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = null;
      void this.#publish();
    }, this.#config.pushMinIntervalMs);
    this.#publishTimer.unref?.();
  }

  /**
   * Connect the relay, if one is configured.
   *
   * Monitoring works without it: with no repo URL the bridge simply writes
   * locally, which is the read-only case.
   */
  async #startRelay(): Promise<void> {
    const { repoUrl, repoToken, outBranch, inBranch } = this.#config;
    if (!repoUrl) return;

    const relay = new RelaySync({
      repoUrl,
      token: repoToken,
      outBranch,
      inBranch,
      // Separate clones: a force-push on the outbound branch must not disturb
      // the working tree holding un-consumed inbound prompts.
      outCloneDir: join(this.#config.stateDir, 'repo-out'),
      inCloneDir: join(this.#config.stateDir, 'repo-in'),
      outDir: this.#config.outDir,
      log: (message) => process.stderr.write(`[relay] ${message}\n`),
    });

    try {
      await relay.init();
      this.#relay = relay;
    } catch (error) {
      // A broken relay must not stop local monitoring.
      process.stderr.write(`[relay] unavailable: ${String(error)}\n`);
    }
  }

  /**
   * Publish, if there is anything to publish.
   *
   * Only one publish at a time. The debounce timer can fire while a previous
   * publish is still mid-copy, and two of them racing on the same clone — one
   * clearing the output subtree while the other copies into it — fails with
   * EEXIST and loses whichever attempt noticed.
   */
  #publish(): Promise<void> {
    const relay = this.#relay;
    if (!relay || !this.#relayDirty) return Promise.resolve();

    if (this.#publishInFlight !== null) {
      this.#republish = true;
      return this.#publishInFlight;
    }

    const run = this.#runPublish().finally(() => {
      if (this.#publishInFlight === run) this.#publishInFlight = null;
    });
    this.#publishInFlight = run;
    return run;
  }

  /**
   * Publish now, whatever the debounce would have said.
   *
   * This is the last thing the bridge does before it exits, and it is the only
   * publish that carries a session's *ending*: a session that has stopped
   * produces no further event, so nothing else would ever mark it. Waiting on an
   * in-flight publish first is deliberate — the two would otherwise race on the
   * same clone, and the loser is whichever of them the process finished with.
   *
   * Marking the relay dirty happens **after** that wait, and the order is the
   * whole trick: a publish clears the flag on its way out, so setting it first
   * means the flag is already back to false by the time the only publish that
   * matters reads it — and that publish then finds nothing to send.
   */
  async #publishNow(): Promise<void> {
    if (this.#publishInFlight !== null) await this.#publishInFlight.catch(() => {});
    this.#relayDirty = true;
    await this.#publish();
  }

  async #runPublish(): Promise<void> {
    const relay = this.#relay;
    if (!relay) return;

    try {
      // Seal every open chunk before publishing, so anything the reader can
      // fetch is complete.
      //
      // Chunk numbers advance only on a seal, so an open chunk is one the reader
      // can see named in `head.json` but cannot validate: it has no sentinel,
      // and the reader correctly refuses to cache or trust it. A session whose
      // turns are small enough never to fill a chunk would therefore never
      // publish anything readable at all — which is most sessions.
      for (const runtime of this.#sessions.values()) {
        await runtime.chunker.seal().catch(() => {});
        await this.#writeHead(runtime).catch(() => {});
      }

      const outcome = await relay.publish(`relay: ${new Date().toISOString()}`);
      if (outcome !== 'failed') this.#relayDirty = false;
      else process.stderr.write('[relay] publish failed; will retry on the next tick\n');
    } catch (error) {
      process.stderr.write(`[relay] publish error: ${String(error)}\n`);
    } finally {
      // A trigger that arrived mid-publish must not be dropped: there may be no
      // further turn boundary for a long time, and the data would sit unsent.
      if (this.#republish) {
        this.#republish = false;
        this.#schedulePublish();
      }
    }
  }

  /**
   * Read prompts the phone has written.
   *
   * Verified prompts are recorded but **not** consumed yet: injection arrives
   * with the `ccr` wrapper, and consuming a prompt we cannot deliver would lose
   * it silently. Prompts are marked seen so a rejected one is reported once
   * rather than on every poll.
   */
  async #pollInbound(): Promise<void> {
    const relay = this.#relay;
    if (!relay) return;

    let names: string[];
    try {
      names = await relay.listInbound();
    } catch {
      return;
    }

    for (const name of names) {
      const raw = await relay.readInbound(name);
      const promptId = extractPromptId(raw) ?? name;
      if (this.#seenPrompts.has(promptId)) continue;
      this.#seenPrompts.add(promptId);

      const secret = this.#config.secret;
      if (!secret) {
        process.stderr.write(`[relay] ignoring ${name}: CCR_SECRET is not set\n`);
        continue;
      }

      const result = verifyPrompt(raw, { secret, maxAgeMs: this.#config.promptMaxAgeMs });
      if (!result.ok) {
        process.stderr.write(`[relay] rejected ${name}: ${result.reason}\n`);
        // Taken from a separate parse: the failure branch carries no prompt, but
        // a rejected attempt still deserves to be visible against its session.
        const target = parseInboundPrompt(raw)?.sessionId ?? null;
        await this.#recordInjection(promptId, target, 'rejected', result.reason);
        await relay.markConsumed([name]).catch(() => {});
        continue;
      }

      await this.#deliverPrompt(result.prompt, name);
    }
  }

  /**
   * Hand a verified prompt to the session that owns it.
   *
   * The outcome is always recorded against the session, including refusals,
   * because a prompt that silently goes nowhere is the worst possible result:
   * the phone shows "awaiting acknowledgement" and nothing anywhere says why.
   */
  async #deliverPrompt(
    prompt: { sessionId: string; promptId: string; text: string },
    inboundName: string,
  ): Promise<void> {
    const relay = this.#relay;
    const runtime = this.#sessions.get(prompt.sessionId);
    const entry = this.#registry.get(prompt.sessionId) ?? null;

    const refuse = async (state: 'rejected', reason: string): Promise<void> => {
      process.stderr.write(`[relay] refusing ${prompt.promptId}: ${reason}\n`);
      await this.#recordInjection(prompt.promptId, prompt.sessionId, state, reason);
      // Consumed either way: a refusal is an answer, and leaving it in place
      // would re-evaluate the same prompt on every poll forever.
      await relay?.markConsumed([inboundName]).catch(() => {});
    };

    const registration = entry ? this.#controlledPids.get(entry.pid) : undefined;
    const facts = hookFacts(this.#hookState.get(prompt.sessionId));

    const refusal = injectionRefusal({
      injectionEnabled: this.#config.allowInjection,
      hasSession: Boolean(runtime && entry),
      controllable: Boolean(registration),
      lastMainKind: runtime?.lastMainKind ?? null,
      // Freshness is a fact about the *session*, so it is the transcript that
      // decides it, not this process's record. Requiring an empty transcript is
      // what makes "nothing has run" true; `seq === 0` alone only means this
      // bridge has no chunks for it, which is also what a long-running session
      // looks like after its output directory is emptied. See `isFreshSession`.
      isFresh:
        runtime !== undefined &&
        isFreshSession(runtime.aggregator.seq, runtime.tailer.size),
      // Passed as they stand even when they are not trusted, so the guard's
      // decision is legible from its inputs; `hooksLive` is what gates using
      // them, and it is false when the stream is missing or has gone quiet.
      hooksLive: this.#hooksTrusted(prompt.sessionId, runtime),
      dialogOpen: facts.dialogOpen,
      toolInFlight: facts.toolInFlight,
    });
    if (refusal) {
      // Spell out the reasons a person will actually hit, and what to do about
      // each. The bare reason alone tells them nothing.
      return refuse('rejected', REFUSAL_DETAIL[refusal] ?? refusal);
    }

    // The guard has already refused when either is missing; repeating it here is
    // what narrows the types for the rest of the function.
    if (!registration || !entry) return refuse('rejected', 'not-controllable');

    const reply = await sendControlMessage(registration.pipe, {
      type: 'prompt',
      promptId: prompt.promptId,
      text: prompt.text,
    });

    if (!reply) return refuse('rejected', 'session-unreachable');
    if (reply.type !== 'accepted') return refuse('rejected', reply.reason ?? 'refused');

    process.stderr.write(`[relay] typed ${prompt.promptId} into pid ${entry.pid}\n`);

    // Watch for it coming back as a turn.
    const waiting = this.#awaitingDelivery.get(prompt.sessionId) ?? [];
    waiting.push({ promptId: prompt.promptId, text: prompt.text, at: Date.now() });
    this.#awaitingDelivery.set(prompt.sessionId, waiting);

    // 'accepted' means it reached the terminal, not that Claude acted on it.
    // Only the transcript can confirm that, and it usually does so within a
    // second or two — so this is a waypoint, not the final word.
    await this.#recordInjection(prompt.promptId, prompt.sessionId, 'accepted', 'typed into the session');
    await this.#relay?.markConsumed([inboundName]).catch(() => {});
  }

  /**
   * Match a transcript turn against prompts we typed, and report the ones that
   * arrived.
   *
   * Comparison is on normalised text, with a long-prefix fallback because the
   * parser truncates long prompts — a truncation marker must not read as a
   * mismatch and leave a delivered prompt looking lost.
   *
   * **The caller must hold the session's queue**, since this writes an event.
   * Callers are the append path, which holds it for the whole batch.
   */
  async #confirmDelivery(runtime: SessionRuntime, turnText: string): Promise<void> {
    const sessionId = runtime.sessionId;
    let waiting = this.#awaitingDelivery.get(sessionId);
    if (!waiting || waiting.length === 0) return;

    // Drop anything old enough that it will never arrive, so the list cannot
    // grow without bound over a long session.
    const cutoff = Date.now() - 10 * 60 * 1000;
    waiting = waiting.filter((entry) => entry.at >= cutoff);
    this.#awaitingDelivery.set(sessionId, waiting);
    if (waiting.length === 0) return;

    const index = matchDeliveredTurn(waiting, turnText);
    if (index === -1) return;

    const [arrived] = waiting.splice(index, 1);
    if (arrived) {
      await this.#writeSynthetic(runtime, {
        ts: new Date().toISOString(),
        sessionId,
        agentId: null,
        kind: 'injection',
        promptId: arrived.promptId,
        state: 'delivered',
        detail: 'reached the session',
      });
    }
  }

  /**
   * Append one event the bridge originated rather than read from a transcript.
   *
   * **The caller must hold the session's queue.** Taking a sequence number and
   * writing the event have to be one step, or a number taken here can be written
   * ahead of one that was handed out earlier and is still on its way.
   */
  async #writeSynthetic(runtime: SessionRuntime, draft: EventDraft): Promise<void> {
    const event = runtime.aggregator.record(draft);
    await runtime.chunker.append(event);
    this.#relayDirty = true;
    runtime.stateDirty = true;
  }

  /**
   * Surface a prompt's fate in the session timeline, so the phone sees it.
   *
   * Queued rather than written directly: this is called from the relay poll and
   * from the hook receiver, both of which run on their own schedules and can
   * otherwise land in the middle of a transcript batch.
   */
  async #recordInjection(
    promptId: string,
    sessionId: string | null,
    // The full set, not just the two this started with: a prompt typed into a
    // session is later confirmed as delivered by the transcript, and that
    // upgrade is the difference between "we typed it" and "it arrived".
    state: InjectionState,
    detail: VerifyFailure | string,
  ): Promise<void> {
    if (!sessionId) return;
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) return;

    await runtime.queue.run(() =>
      this.#writeSynthetic(runtime, {
        ts: new Date().toISOString(),
        sessionId,
        agentId: null,
        kind: 'injection',
        promptId,
        state,
        detail,
      }),
    );
  }

  /**
   * Surface a moment worth waking the phone for.
   *
   * A permission dialog is the clearest one there is: the PC is stopped, nothing
   * will move until someone answers, and the transcript has no entry for it — so
   * before hooks, the phone could only guess at it from `status`/`waitingFor`,
   * which the session registry does not reliably carry.
   */
  async #recordAttention(
    runtime: SessionRuntime,
    text: string,
    level: AttentionLevel,
  ): Promise<void> {
    // Queued: a hook arrives from the receiver's own HTTP handler, which is
    // exactly the kind of caller that lands in the middle of a transcript batch.
    await runtime.queue.run(() =>
      this.#writeSynthetic(runtime, {
        ts: new Date().toISOString(),
        sessionId: runtime.sessionId,
        agentId: null,
        kind: 'attention',
        text,
        level,
      }),
    );
    runtime.stateDirty = true;
    // One of the few events worth a publish on its own — the phone is meant to
    // show this while the session sits there blocked.
    this.#schedulePublish();
  }

  /**
   * Refuse to run alongside another bridge.
   *
   * Two bridges share one state directory and one clone, so they race on the
   * working tree, the tail offsets and the same git index. The failures are
   * confusing rather than obvious — chunk files end up with a mix of valid and
   * invalid checksums, which reads as corrupt data rather than as two processes
   * fighting over it. This happened twice in practice.
   *
   * **A heartbeat, not a pid.** Stopping an `npm run` wrapper does not reliably
   * stop the node process it spawned, and the orphan holds the state directory
   * while its parent's pid — the one a static lock would record — is gone. So a
   * stale lock was taken over while the orphan was still writing. The holder now
   * refreshes a timestamp, and a newcomer refuses while that timestamp is fresh,
   * which detects a live writer no matter who started it.
   *
   * The pid is kept for the error message only; it is not trusted.
   *
   * The rules themselves live in `lock.ts`, because `ccr` starts a bridge and so
   * has to reach the same verdict — see there for why agreement matters.
   */
  async #acquireLock(): Promise<void> {
    const path = lockPath(this.#config.stateDir);
    const lock = await readLock(this.#config.stateDir);
    const age = lockAgeMs(lock, Date.now());

    if (lock !== null && lockIsLive(lock, this.#config.lockStaleMs)) {
      throw new Error(
        `another bridge is already running (pid ${lock.pid ?? 'unknown'}, last seen ${Math.round(age / 1000)}s ago). ` +
          `Stop it first, or delete ${path} if you are certain it is gone.`,
      );
    }

    if (lock !== null) {
      // `Infinity` is how a lock with no readable timestamp reads; saying
      // "Infinity seconds ago" is worse than saying nothing.
      const seen = Number.isFinite(age) ? `${Math.round(age / 1000)}s ago` : 'never';
      process.stderr.write(
        `[bridge] taking over a lock last refreshed ${seen} (pid ${lock.pid ?? 'unknown'})\n`,
      );
    }

    await this.#writeLock();
  }

  /** Refresh the lock, so a newcomer can tell we are still here. */
  async #heartbeat(): Promise<void> {
    if (!this.#running) return;
    await this.#writeLock().catch(() => {});
  }

  async #writeLock(): Promise<void> {
    await writeFile(
      lockPath(this.#config.stateDir),
      JSON.stringify({ pid: process.pid, heartbeat: Date.now(), startedAt: new Date().toISOString() }),
    );
  }

  async #releaseLock(): Promise<void> {
    await rm(lockPath(this.#config.stateDir), { force: true }).catch(() => {});
  }

  /**
   * Finish, and leave the relay saying what is true.
   *
   * The order matters at the end. The registry is read *first* so the last thing
   * published describes the world as it is now — in the case this exists for,
   * the `ccr` session has already unregistered and the session reads `ended` —
   * and the publish is *last*, after every file it carries has been written,
   * because a relay that is told about a state it cannot yet read is no better
   * than one that was never told.
   */
  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    if (this.#publishTimer !== null) {
      clearTimeout(this.#publishTimer);
      this.#publishTimer = null;
    }

    // Closed before anything else, so a hook arriving mid-shutdown cannot be
    // answered with state that is about to disappear.
    const hooks = this.#hooks;
    this.#hooks = null;
    await hooks?.close().catch(() => {});

    await this.#refreshRegistry().catch(() => {});

    // Seal every open chunk so nothing is left unadvertised.
    for (const runtime of this.#sessions.values()) {
      await runtime.chunker.finish().catch(() => {});
      await this.#writeHead(runtime).catch(() => {});
    }

    await this.#writeIndex(true).catch(() => {});
    await this.#persist();
    await this.#publishNow().catch(() => {});
    await this.#releaseLock();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async #loadPersisted(): Promise<void> {
    try {
      const raw = await readFile(join(this.#config.stateDir, 'bridge-state.json'), 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed && parsed.version === 1) {
        // Tolerate a state file written before this field existed.
        this.#persisted = { ...parsed, seenPrompts: parsed.seenPrompts ?? [] };
        this.#seenPrompts = new Set(this.#persisted.seenPrompts);
      }
    } catch {
      // No prior state: every session starts from a cold-start window.
    }
  }

  async #persist(): Promise<void> {
    const tails: Record<string, TailState> = {};
    const sessions: PersistedState['sessions'] = {};

    for (const runtime of this.#sessions.values()) {
      tails[runtime.tailer.path] = runtime.tailer.getState();
      for (const agent of runtime.agents.values()) tails[agent.tailer.path] = agent.tailer.getState();
      sessions[runtime.sessionId] = {
        seq: runtime.aggregator.seq,
        lastMainKind: runtime.lastMainKind,
      };
    }

    this.#persisted = { version: 1, tails, sessions, seenPrompts: [...this.#seenPrompts] };

    const path = join(this.#config.stateDir, 'bridge-state.json');
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#persisted)).catch(() => {});
    await rename(tmp, path).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async #rescan(): Promise<void> {
    const found = await scanProjects(this.#config.projectsDir);

    for (const discovered of found) {
      if (this.#sessions.has(discovered.sessionId)) continue;
      await this.#addSession(discovered);
    }
  }

  /** True when a session directory physically holds at least one chunk. */
  async #hasChunks(dir: string): Promise<boolean> {
    try {
      const names = await readdir(dir);
      return names.some((n) => n.startsWith('events-') && n.endsWith('.jsonl'));
    } catch {
      return false;
    }
  }

  async #addSession(discovered: DiscoveredSession): Promise<void> {
    const sessionDir = join(this.#config.outDir, 'sessions', discovered.sessionId);
    const manifestPath = join(this.#config.stateDir, 'manifests', `${discovered.sessionId}.json`);

    // Offsets and output are restored together, or not at all.
    //
    // If the output is missing but a saved offset survives, the two disagree
    // permanently: the writer starts again at chunk 1 while the tailer believes
    // those events were already consumed, so the relay stays empty and nothing
    // reports a problem. Treating a missing output as "never seen" makes the
    // output the authority and lets it be rebuilt.
    // Checked against the chunks themselves rather than the manifest, because
    // the manifest now lives outside the output tree and would survive its
    // deletion — reporting "output present" for a session whose chunks are gone.
    const hasOutput = await this.#hasChunks(sessionDir);

    // A surviving manifest describes chunks that no longer exist; discard it so
    // the range it reports cannot be published.
    if (!hasOutput) {
      await rm(manifestPath, { force: true }).catch(() => {});
    }

    const saved = hasOutput ? this.#persisted.sessions[discovered.sessionId] : undefined;
    const savedTail = hasOutput ? this.#persisted.tails[discovered.transcriptPath] : undefined;

    const tailer = new Tailer(
      discovered.transcriptPath,
      { coldStartBytes: this.#config.coldStartBytes },
      savedTail,
    );

    const chunker = new ChunkWriter({
      dir: sessionDir,
      retainBytes: this.#config.retainBytes,
      maxChunks: this.#config.maxChunksPerSession,
      // Bookkeeping lives outside the published tree: it is rewritten on every
      // seal, and publishing it would add a changed blob to every publish for
      // the reader to ignore.
      manifestPath,
    });
    await chunker.open(discovered.sessionId);

    // Past everything already written, not merely past the last value the
    // five-second persist timer happened to catch: the chunker's position comes
    // from the events on disk, which is what the reader will see.
    const aggregator = new SessionAggregator(
      discovered.sessionId,
      resumeSeq(saved?.seq, chunker.lastSeq),
    );

    this.#sessions.set(discovered.sessionId, {
      sessionId: discovered.sessionId,
      discovered,
      tailer,
      aggregator,
      chunker,
      queue: new SerialQueue(),
      agents: new Map(),
      stateDirty: true,
      lastAgentScan: 0,
      // Restored rather than started null: the guard depends on it, and a
      // session idle since before this process began would otherwise look
      // permanently busy. When nothing was persisted — an upgrade, or state
      // lost — it is recovered from the events already on disk rather than
      // waited for, since waiting means refusing every prompt until the session
      // happens to emit something on its own.
      lastMainKind: saved?.lastMainKind ?? (await chunker.readLastMainKind()),
      // Not persisted, and deliberately: hook state is in memory only, and a
      // restart means no hooks have been heard from yet in this process.
      lastMainEventAt: 0,
    });
  }

  async #refreshRegistry(): Promise<void> {
    const entries = await readRegistry(this.#config.sessionsDir);
    this.#registry = new Map(entries.map((e) => [e.sessionId, e]));

    // Sessions launched through `ccr` register themselves; matching on pid is
    // what separates a session we can type into from one we can only watch.
    const controlled = await readControlled(this.#config.stateDir);
    this.#controlledPids = new Map(controlled.map((c) => [c.pid, c]));

    for (const runtime of this.#sessions.values()) {
      const entry = this.#registry.get(runtime.sessionId) ?? null;
      const controllable = entry !== null && this.#controlledPids.has(entry.pid);
      if (!runtime.aggregator.applyRegistry(entry, controllable)) continue;

      runtime.stateDirty = true;
      // **A state change is not an event, and nothing else would publish it.**
      // The registry is where a session ending is observed — its transcript just
      // stops, so there is no last line to trigger a push on. Without this the
      // phone keeps whatever status it was last told, forever, because the thing
      // that would have corrected it emits nothing more.
      //
      // These transitions are rare — starting, ending, going idle, blocking,
      // becoming controllable — as against turn boundaries, which are frequent,
      // so this is nowhere near the push budget the debounce exists to protect.
      this.#relayDirty = true;
      this.#schedulePublish();
    }
  }

  // -------------------------------------------------------------------------
  // The poll round
  // -------------------------------------------------------------------------

  async #tick(): Promise<void> {
    if (!this.#running) return;

    // Checked on every tick rather than on the slower registry interval: this is
    // the difference between a `ccr` that exits promptly and one that sits at the
    // shell for three seconds after Claude Code is gone.
    //
    // The claim is taken *before* the read, because ticks overlap: two of them
    // awaiting the same file would both find the request and both ask for a
    // shutdown. Released again when there was nothing to answer.
    if (!this.#honouringStop) {
      this.#honouringStop = true;
      if (await this.#stopWasRequested().catch(() => false)) {
        const reason = 'a ccr session asked this bridge to stop';
        if (this.#options.onStopRequested) this.#options.onStopRequested(reason);
        else process.stderr.write(`[bridge] ${reason}, but nothing is listening for it\n`);
        return;
      }
      this.#honouringStop = false;
    }

    for (const runtime of this.#sessions.values()) {
      try {
        await this.#tickSession(runtime);
      } catch {
        // One bad session must not stop the others.
      }
    }

    await this.#writeIndex();
  }

  /**
   * Whether a `ccr` session has asked this exact process to stop.
   *
   * The pid check is the whole safety of it. A request left behind by a `ccr`
   * that crashed names a bridge that is already gone, and without the check that
   * file would stop whichever bridge started next — which is the same class of
   * bug the request exists to fix.
   */
  async #stopWasRequested(): Promise<boolean> {
    return isStopRequestFor(await readStopRequest(this.#config.stateDir), process.pid);
  }

  async #tickSession(runtime: SessionRuntime): Promise<void> {
    // Subagent artifacts appear throughout a session's life — a session can
    // spawn its fifth agent an hour in — so this is rescanned, not done once.
    const now = Date.now();
    if (now - runtime.lastAgentScan >= 3_000) {
      runtime.lastAgentScan = now;
      for (const discovered of await scanAgents(runtime.discovered.sessionDir)) {
        if (runtime.agents.has(discovered.agentId)) continue;
        runtime.agents.set(discovered.agentId, {
          ...discovered,
          tailer: new Tailer(
            discovered.jsonlPath,
            { coldStartBytes: this.#config.coldStartBytes },
            this.#persisted.tails[discovered.jsonlPath],
          ),
          metaLoaded: false,
        });
      }
    }

    // The meta file carries parentAgentId, which is the only source of nesting.
    for (const agent of runtime.agents.values()) {
      if (agent.metaLoaded) continue;
      const meta = await readJson(agent.metaPath);
      if (meta === null) continue;
      agent.metaLoaded = true;
      if (runtime.aggregator.registerSubagentMeta(meta, agent.agentId)) {
        runtime.stateDirty = true;
      }
    }

    const main = await runtime.tailer.poll();
    for (const line of main) {
      // Numbering and writing are one serialised step. `ingest` hands out a
      // number for every event the line yields, and it appends them one at a
      // time; a synthetic event recorded during one of those awaits would be
      // written ahead of a number this batch already took.
      await runtime.queue.run(async () => {
        const result = runtime.aggregator.ingest(line, null);
        await this.#append(runtime, result.events);
        if (result.stateDirty) runtime.stateDirty = true;
      });
    }

    for (const agent of runtime.agents.values()) {
      const lines = await agent.tailer.poll();
      for (const line of lines) {
        // Attribution matters: subagent transcripts carry the parent's
        // sessionId, so without the agent id these events would be
        // indistinguishable from the main thread's.
        await runtime.queue.run(async () => {
          const result = runtime.aggregator.ingest(line, agent.agentId);
          await this.#append(runtime, result.events, true);
          if (result.stateDirty) runtime.stateDirty = true;
        });
      }
    }

    if (runtime.stateDirty) {
      await this.#writeHead(runtime);
      runtime.stateDirty = false;
    }
  }

  /**
   * Write a batch of already-sequenced events, and decide what to publish.
   *
   * Only turn boundaries and attention signals justify a publish. Everything else
   * accumulates locally until one of those arrives, which is what keeps pushes
   * rare enough for the repository to stay small.
   *
   * **The caller must hold the session's queue.** Every event here already
   * carries a number handed out by `ingest`, so nothing else may append to this
   * session's stream until the batch has been written.
   */
  async #append(
    runtime: SessionRuntime,
    events: readonly NormalizedEvent[],
    fromAgent = false,
  ): Promise<void> {
    /** Prompts in this batch that need checking against what we typed. */
    const arrived: string[] = [];

    for (const event of events) {
      try {
        await runtime.chunker.append(event);
      } catch (error) {
        // An event the writer will not take — the ceiling in `MAX_EVENT_BYTES`
        // is the designed case — is reported and skipped, rather than thrown at
        // the caller and taking the rest of the batch with it. The gap in the
        // sequence is real and the phone will show it, which is the honest
        // outcome: this event was never written.
        process.stderr.write(
          `[bridge] dropped an event from ${runtime.sessionId}: ${String(error)}\n`,
        );
        continue;
      }

      if (!fromAgent) {
        // Synthesized events are skipped — see SYNTHESIZED_KINDS. A title change
        // arrives through this same path and must not answer "is the turn over?".
        runtime.lastMainKind = advanceLastMainKind(runtime.lastMainKind, event.kind);
        // The session's own clock, not the time we read the line: a cold-start
        // replay of yesterday's events must not look like activity now.
        const at = Date.parse(event.ts);
        if (Number.isFinite(at) && at > runtime.lastMainEventAt) runtime.lastMainEventAt = at;

        // A prompt we typed has shown up as a turn, but confirming that takes
        // the next sequence number — so it is collected here and recorded below,
        // once the batch is whole.
        if (event.kind === 'user_prompt') arrived.push(event.text);
      }

      this.#relayDirty = true;
      // Appending moves the chunk range, and `head.json` is what tells the
      // reader about it. Leaving this to the aggregator's own dirty flag would
      // mean a turn that only streams text never republishes its head — the
      // reader would poll, see nothing had changed, and never fetch the chunks
      // that had actually been written.
      runtime.stateDirty = true;
      if (PUBLISH_TRIGGERS.has(event.kind)) this.#schedulePublish();
    }

    // **After the batch, never inside it.** Recording a delivery allocates the
    // next sequence number, and doing that between two events of this batch
    // wrote it ahead of a number already handed out: a `user_prompt` at 7 and
    // its `turn_start` at 8 came out as `7, 9, 8`, which the reader can only
    // report as a tear. Every prompt sent from the phone produced one.
    for (const text of arrived) await this.#confirmDelivery(runtime, text);
  }

  /** Write the per-session file the reader polls while a session is open. */
  async #writeHead(runtime: SessionRuntime): Promise<void> {
    const dir = join(this.#config.outDir, 'sessions', runtime.sessionId);
    const head = buildSessionHead({
      state: runtime.aggregator.state,
      range: runtime.chunker.range,
      now: new Date(),
      injectionEnabled: this.#config.allowInjection,
    });

    await atomicWriteJson(join(dir, 'head.json'), head);
    await atomicWriteJson(join(dir, 'subagents.json'), runtime.aggregator.subagentTree());
  }

  /**
   * Publish the session list the phone reads first.
   *
   * `force` is for shutdown. The throttle below is a courtesy to the disk during
   * ordinary ticking, but the last write a process makes is the one the relay
   * keeps, and skipping it leaves the phone reading the status from two seconds
   * before the session ended.
   */
  async #writeIndex(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.#lastIndexWrite < 2_000) return;
    this.#lastIndexWrite = now;

    const sessions: SessionIndexEntry[] = [...this.#sessions.values()]
      // Only relay what is worth looking at: a session with events, or one still
      // running. Otherwise every transcript ever written on this machine appears
      // in the phone's list as an empty entry.
      .filter((runtime) => {
        const state = runtime.aggregator.state;
        return runtime.chunker.range.retainedBytes > 0 || state.status !== 'ended';
      })
      .map((runtime) => {
      const state = runtime.aggregator.state;
      return {
        sessionId: runtime.sessionId,
        project: state.project,
        title: state.title,
        status: state.status,
        updatedAt: state.updatedAt,
        lastSeq: runtime.aggregator.seq,
        controllable: state.controllable,
        ...(state.cost ? { costUSD: state.cost.totalCostUSD } : {}),
      };
    });

    // Most recently updated first — that is the order the phone wants.
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const { kept, dropped } = this.#applySessionCap(sessions);
    for (const entry of dropped) await this.#forgetSession(entry.sessionId);

    const index = buildRelayIndex({
      sessions: kept,
      injectionEnabled: this.#config.allowInjection,
      now: new Date(),
    });
    await atomicWriteJson(join(this.#config.outDir, 'index.json'), index);
  }

  /**
   * Split the session list into what is kept and what falls past the cap.
   *
   * Active sessions are never counted against the cap or dropped: a limit that
   * deletes a running session's history mid-turn is a bug, not a policy. The cap
   * therefore bounds how much *finished* history accumulates, which is the part
   * that would otherwise grow forever.
   */
  #applySessionCap(sessions: readonly SessionIndexEntry[]): {
    kept: SessionIndexEntry[];
    dropped: SessionIndexEntry[];
  } {
    const active = sessions.filter((s) => s.status !== 'ended');
    const ended = sessions.filter((s) => s.status === 'ended');
    const room = Math.max(0, this.#config.maxSessions - active.length);

    return { kept: [...active, ...ended.slice(0, room)], dropped: ended.slice(room) };
  }

  /** Delete a session's relayed data and stop tracking it. */
  async #forgetSession(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
    // Its hook state goes too: keeping it would leak one entry per session ever
    // seen, and a forgotten session has no prompt left to guard.
    this.#hookState.delete(sessionId);
    await rm(join(this.#config.outDir, 'sessions', sessionId), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}

/**
 * The contents of `head.json`.
 *
 * `heartbeat` is the bridge's own clock, not the session's: `updatedAt` stops
 * moving when the session goes idle, so it cannot answer the one question the
 * phone has — "is the PC still publishing?" A reader that gets no heartbeat, or
 * an old one, is told the record has gone stale rather than left believing it
 * is live because Gitee answered.
 *
 * `injectionEnabled` is here as well as in `index.json` because this is the only
 * file a reader polls while a session is open. Without it, opening straight into
 * a session — a deep link, a reload — leaves the reader with no index and no way
 * to tell "the PC refuses prompts" from "I have not asked".
 *
 * Pure and exported so the promise is testable: it is a contract between two
 * packages that do not share a build.
 */
export function buildSessionHead(options: {
  state: SessionState;
  range: ChunkRange;
  now: Date;
  injectionEnabled: boolean;
}): SessionHead {
  return {
    ...options.state,
    ...options.range,
    heartbeat: options.now.toISOString(),
    injectionEnabled: options.injectionEnabled,
  };
}

/** The contents of `index.json`, with the same heartbeat alongside `generatedAt`. */
export function buildRelayIndex(options: {
  sessions: SessionIndexEntry[];
  injectionEnabled: boolean;
  now: Date;
}): RelayIndex {
  const at = options.now.toISOString();
  return {
    version: 1,
    generatedAt: at,
    heartbeat: at,
    sessions: options.sessions,
    injectionEnabled: options.injectionEnabled,
  };
}

/**
 * Best-effort prompt id from a raw payload.
 *
 * Used only for de-duplication, so an unreadable payload falls back to the
 * filename rather than being discarded — a malformed prompt still deserves to be
 * reported once instead of silently ignored.
 */
function extractPromptId(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = (raw as Record<string, unknown>)['promptId'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function main(): Promise<void> {
  const config = bootstrapConfig();

  const shutdown = (): void => {
    void bridge.stop().then(() => process.exit(0));
  };

  // The same exit as a signal takes. A `ccr` session asking us to stop is not a
  // request to die on the spot: the last registry read, the last head and the
  // last publish are the entire point of it being asked rather than killed.
  const bridge = new Bridge(config, {
    onStopRequested: (reason) => {
      process.stderr.write(`[bridge] stopping: ${reason}\n`);
      shutdown();
    },
  });

  await bridge.start();
  process.stdout.write(
    `ccr bridge watching ${config.projectsDir}\n` +
      `  chunks -> ${config.outDir}\n` +
      `  state  -> ${config.stateDir}\n`,
  );

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('/dist/index.js');
if (isDirect) {
  main().catch((error: unknown) => {
    process.stderr.write(`bridge failed: ${String(error)}\n`);
    process.exit(1);
  });
}

/** Exported for tests and for the sync layer. */
export type { NormalizedEvent };
