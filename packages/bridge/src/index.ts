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
  type NormalizedEvent,
  type RelayIndex,
  type RegistryEntry,
  type SessionHead,
  type SessionIndexEntry,
} from '@ccr/shared';

import { ChunkWriter, atomicWriteJson } from './chunker.js';
import { type BridgeConfig, loadConfig, loadEnvFile } from './config.js';
import { readControlled } from './control.js';
import { parseInboundPrompt, verifyPrompt, type VerifyFailure } from './inbound.js';
import { RelaySync } from './sync.js';
import {
  readJson,
  readRegistry,
  scanAgents,
  scanProjects,
  type DiscoveredSession,
} from './discovery.js';
import { SessionAggregator } from './session.js';
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

interface PersistedState {
  version: 1;
  tails: Record<string, TailState>;
  sessions: Record<string, { seq: number }>;
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
  agents: Map<string, AgentRuntime>;
  stateDirty: boolean;
  /** Agents appear throughout a session's life, so discovery is re-run. */
  lastAgentScan: number;
}

export class Bridge {
  readonly #config: BridgeConfig;
  #sessions = new Map<string, SessionRuntime>();
  #registry = new Map<string, RegistryEntry>();
  #persisted: PersistedState = { version: 1, tails: {}, sessions: {}, seenPrompts: [] };
  #timers: NodeJS.Timeout[] = [];
  #running = false;
  #lastIndexWrite = 0;
  #relay: RelaySync | null = null;
  #relayDirty = false;
  #seenPrompts = new Set<string>();
  /** Pids of sessions launched through `ccr`, refreshed with the registry. */
  #controlledPids = new Set<number>();
  #publishTimer: NodeJS.Timeout | null = null;

  constructor(config: BridgeConfig) {
    this.#config = config;
  }

  get sessions(): ReadonlyMap<string, SessionRuntime> {
    return this.#sessions;
  }

  async start(): Promise<void> {
    this.#running = true;
    await mkdir(this.#config.outDir, { recursive: true });
    await mkdir(this.#config.stateDir, { recursive: true });
    await this.#loadPersisted();

    await this.#rescan();
    await this.#tick();

    await this.#startRelay();

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
   * Coalesce a publish.
   *
   * Turn boundaries arrive in bursts — a session can end several turns in quick
   * succession — and each publish rewrites the branch. This collapses them into
   * one, and the floor is a minimum gap rather than an interval: nothing is
   * published unless something actually asked for it.
   */
  #schedulePublish(): void {
    if (!this.#relay || this.#publishTimer) return;
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

  async #publish(): Promise<void> {
    const relay = this.#relay;
    if (!relay || !this.#relayDirty) return;

    try {
      const outcome = await relay.publish(`relay: ${new Date().toISOString()}`);
      if (outcome !== 'failed') this.#relayDirty = false;
      if (outcome === 'failed') {
        process.stderr.write('[relay] publish failed; will retry on the next tick\n');
      }
    } catch (error) {
      process.stderr.write(`[relay] publish error: ${String(error)}\n`);
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
        continue;
      }

      // Authenticated. Injection itself lands with the ccr wrapper.
      await this.#recordInjection(promptId, result.prompt.sessionId, 'accepted', 'awaiting injection');
    }
  }

  /** Surface a prompt's fate in the session timeline, so the phone sees it. */
  async #recordInjection(
    promptId: string,
    sessionId: string | null,
    state: 'accepted' | 'rejected',
    detail: VerifyFailure | string,
  ): Promise<void> {
    if (!sessionId) return;
    const runtime = this.#sessions.get(sessionId);
    if (!runtime) return;

    const event = runtime.aggregator.record({
      ts: new Date().toISOString(),
      sessionId,
      agentId: null,
      kind: 'injection',
      promptId,
      state,
      detail,
    });
    await runtime.chunker.append(event);
    this.#relayDirty = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];

    // Seal every open chunk so nothing is left unadvertised.
    for (const runtime of this.#sessions.values()) {
      await runtime.chunker.finish().catch(() => {});
      await this.#writeHead(runtime).catch(() => {});
    }
    await this.#persist();
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
    const sessions: Record<string, { seq: number }> = {};

    for (const runtime of this.#sessions.values()) {
      tails[runtime.tailer.path] = runtime.tailer.getState();
      for (const agent of runtime.agents.values()) tails[agent.tailer.path] = agent.tailer.getState();
      sessions[runtime.sessionId] = { seq: runtime.aggregator.seq };
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
      // Bookkeeping lives outside the published tree: it is rewritten on every
      // seal, and publishing it would add a changed blob to every publish for
      // the reader to ignore.
      manifestPath,
    });
    await chunker.open(discovered.sessionId);

    const aggregator = new SessionAggregator(discovered.sessionId, saved?.seq ?? 0);

    this.#sessions.set(discovered.sessionId, {
      sessionId: discovered.sessionId,
      discovered,
      tailer,
      aggregator,
      chunker,
      agents: new Map(),
      stateDirty: true,
      lastAgentScan: 0,
    });
  }

  async #refreshRegistry(): Promise<void> {
    const entries = await readRegistry(this.#config.sessionsDir);
    this.#registry = new Map(entries.map((e) => [e.sessionId, e]));

    // Sessions launched through `ccr` register themselves; matching on pid is
    // what separates a session we can type into from one we can only watch.
    const controlled = await readControlled(this.#config.stateDir);
    this.#controlledPids = new Set(controlled.map((c) => c.pid));

    for (const runtime of this.#sessions.values()) {
      const entry = this.#registry.get(runtime.sessionId) ?? null;
      const controllable = entry !== null && this.#controlledPids.has(entry.pid);
      if (runtime.aggregator.applyRegistry(entry, controllable)) runtime.stateDirty = true;
    }
  }

  // -------------------------------------------------------------------------
  // The poll round
  // -------------------------------------------------------------------------

  async #tick(): Promise<void> {
    if (!this.#running) return;

    for (const runtime of this.#sessions.values()) {
      try {
        await this.#tickSession(runtime);
      } catch {
        // One bad session must not stop the others.
      }
    }

    await this.#writeIndex();
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
      const result = runtime.aggregator.ingest(line, null);
      await this.#append(runtime, result.events);
      if (result.stateDirty) runtime.stateDirty = true;
    }

    for (const agent of runtime.agents.values()) {
      const lines = await agent.tailer.poll();
      for (const line of lines) {
        // Attribution matters: subagent transcripts carry the parent's
        // sessionId, so without the agent id these events would be
        // indistinguishable from the main thread's.
        const result = runtime.aggregator.ingest(line, agent.agentId);
        await this.#append(runtime, result.events);
        if (result.stateDirty) runtime.stateDirty = true;
      }
    }

    if (runtime.stateDirty) {
      await this.#writeHead(runtime);
      runtime.stateDirty = false;
    }
  }

  /**
   * Write an event and decide whether it justifies a publish.
   *
   * Only turn boundaries and attention signals do. Everything else accumulates
   * locally until one of those arrives, which is what keeps pushes rare enough
   * for the repository to stay small.
   */
  async #append(runtime: SessionRuntime, events: readonly NormalizedEvent[]): Promise<void> {
    for (const event of events) {
      await runtime.chunker.append(event);
      this.#relayDirty = true;
      // Appending moves the chunk range, and `head.json` is what tells the
      // reader about it. Leaving this to the aggregator's own dirty flag would
      // mean a turn that only streams text never republishes its head — the
      // reader would poll, see nothing had changed, and never fetch the chunks
      // that had actually been written.
      runtime.stateDirty = true;
      if (PUBLISH_TRIGGERS.has(event.kind)) this.#schedulePublish();
    }
  }

  /** Write the per-session file the reader polls while a session is open. */
  async #writeHead(runtime: SessionRuntime): Promise<void> {
    const dir = join(this.#config.outDir, 'sessions', runtime.sessionId);
    const head: SessionHead = { ...runtime.aggregator.state, ...runtime.chunker.range };

    await atomicWriteJson(join(dir, 'head.json'), head);
    await atomicWriteJson(join(dir, 'subagents.json'), runtime.aggregator.subagentTree());
  }

  /** Publish the session list the phone reads first. */
  async #writeIndex(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastIndexWrite < 2_000) return;
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

    const index: RelayIndex = {
      version: 1,
      generatedAt: new Date().toISOString(),
      sessions: kept,
      injectionEnabled: this.#config.allowInjection,
    };
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
    await rm(join(this.#config.outDir, 'sessions', sessionId), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
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
  loadEnvFile();
  const config = loadConfig();
  const bridge = new Bridge(config);

  await bridge.start();
  process.stdout.write(
    `ccr bridge watching ${config.projectsDir}\n` +
      `  chunks -> ${config.outDir}\n` +
      `  state  -> ${config.stateDir}\n`,
  );

  const shutdown = (): void => {
    void bridge.stop().then(() => process.exit(0));
  };
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
