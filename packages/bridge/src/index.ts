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
  #persisted: PersistedState = { version: 1, tails: {}, sessions: {} };
  #timers: NodeJS.Timeout[] = [];
  #running = false;
  #lastIndexWrite = 0;

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
      if (parsed && parsed.version === 1) this.#persisted = parsed;
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

    this.#persisted = { version: 1, tails, sessions };

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
      for (const event of result.events) await runtime.chunker.append(event);
      if (result.stateDirty) runtime.stateDirty = true;
    }

    for (const agent of runtime.agents.values()) {
      const lines = await agent.tailer.poll();
      for (const line of lines) {
        // Attribution matters: subagent transcripts carry the parent's
        // sessionId, so without the agent id these events would be
        // indistinguishable from the main thread's.
        const result = runtime.aggregator.ingest(line, agent.agentId);
        for (const event of result.events) await runtime.chunker.append(event);
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
