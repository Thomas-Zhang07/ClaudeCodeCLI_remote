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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type NormalizedEvent,
  type RelayIndex,
  type RegistryEntry,
  type SessionIndexEntry,
} from '@ccr/shared';

import { ChunkWriter, atomicWriteJson } from './chunker.js';
import { type BridgeConfig, loadConfig, loadEnvFile } from './config.js';
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
      this.#timers.push(
        setInterval(() => {
          void this.#publish();
        }, this.#config.pushIntervalMs),
        setInterval(() => {
          void this.#pollInbound();
        }, this.#config.pollIntervalMs),
      );
    }
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
      await runtime.chunker.finish(runtime.aggregator.state).catch(() => {});
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

  async #addSession(discovered: DiscoveredSession): Promise<void> {
    const saved = this.#persisted.sessions[discovered.sessionId];

    const tailer = new Tailer(
      discovered.transcriptPath,
      { coldStartBytes: this.#config.coldStartBytes },
      this.#persisted.tails[discovered.transcriptPath],
    );

    const chunker = new ChunkWriter({
      dir: join(this.#config.outDir, 'sessions', discovered.sessionId),
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

    for (const runtime of this.#sessions.values()) {
      const entry = this.#registry.get(runtime.sessionId) ?? null;
      // A session is controllable only when we own its stdin, which for now is
      // never — the ccr wrapper has not been built yet.
      if (runtime.aggregator.applyRegistry(entry, false)) runtime.stateDirty = true;
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
      for (const event of result.events) {
        await runtime.chunker.append(event);
        this.#relayDirty = true;
      }
      if (result.stateDirty) runtime.stateDirty = true;
    }

    for (const agent of runtime.agents.values()) {
      const lines = await agent.tailer.poll();
      for (const line of lines) {
        // Attribution matters: subagent transcripts carry the parent's
        // sessionId, so without the agent id these events would be
        // indistinguishable from the main thread's.
        const result = runtime.aggregator.ingest(line, agent.agentId);
        for (const event of result.events) {
          await runtime.chunker.append(event);
          this.#relayDirty = true;
        }
        if (result.stateDirty) runtime.stateDirty = true;
      }
    }

    if (runtime.stateDirty) {
      await atomicWriteJson(
        join(this.#config.outDir, 'sessions', runtime.sessionId, 'state.json'),
        runtime.aggregator.state,
      );
      await atomicWriteJson(
        join(this.#config.outDir, 'sessions', runtime.sessionId, 'subagents.json'),
        runtime.aggregator.subagentTree(),
      );
      runtime.stateDirty = false;
    }
  }

  /** Publish the session list the phone reads first. */
  async #writeIndex(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastIndexWrite < 2_000) return;
    this.#lastIndexWrite = now;

    const sessions: SessionIndexEntry[] = [...this.#sessions.values()].map((runtime) => {
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

    const index: RelayIndex = {
      version: 1,
      generatedAt: new Date().toISOString(),
      sessions,
    };
    await atomicWriteJson(join(this.#config.outDir, 'index.json'), index);
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
