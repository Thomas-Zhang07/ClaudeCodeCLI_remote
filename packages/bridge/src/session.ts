/**
 * Per-session aggregation: raw lines in, sequenced events and current state out.
 *
 * This is where the responsibilities the pure parser deliberately declined live:
 *
 *  - **Sequencing.** The parser produces drafts; only this layer knows the
 *    session's position in the stream.
 *  - **Last-wins routing.** State entries (cost, mode, title) describe the
 *    present, not the past, so they update state and do not enter the timeline.
 *  - **Title de-duplication.** `ai-title` re-fires on nearly every turn, so a
 *    title event is published only when the value actually changes.
 *  - **Subagent lifecycle.** The parser reports that an agent spawned or handed
 *    back; deciding what that means for the tree belongs here.
 */

import {
  buildSubagentTree,
  parseTranscriptEntry,
  parseSubagentMeta,
  type InjectionEvent,
  type NormalizedEvent,
  type RegistryEntry,
  type SessionState,
  type SessionStatus,
  type SubagentMeta,
  type SubagentNode,
  type SubagentStatus,
} from '@ccr/shared';

export function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    project: null,
    title: null,
    status: 'idle',
    waitingFor: null,
    model: null,
    gitBranch: null,
    controllable: false,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface IngestResult {
  events: NormalizedEvent[];
  state: SessionState;
  /** True when the state changed in a way worth republishing. */
  stateDirty: boolean;
}

export class SessionAggregator {
  readonly sessionId: string;

  #seq: number;
  #state: SessionState;
  #lastTitle: string | null = null;
  #subagents = new Map<string, SubagentMeta>();
  #statuses = new Map<string, SubagentStatus>();
  #models = new Map<string, string>();
  #seenAgents = new Set<string>();
  #lastEventAt = 0;
  /** Most recent real timestamp seen; null until a timestamped line arrives. */
  #lastKnownTs: string | null = null;
  /**
   * A title change observed before any timestamp was available.
   *
   * `ai-title` entries carry no timestamp at all, so a session's first line can
   * reveal a title while giving no time for it. Held here and emitted once a
   * timestamped line arrives, rather than dated to the epoch.
   */
  #pendingTitle: string | null = null;

  constructor(sessionId: string, startSeq = 0, state?: Partial<SessionState>) {
    this.sessionId = sessionId;
    this.#seq = startSeq;
    this.#state = { ...createSessionState(sessionId), ...state };
    this.#lastTitle = this.#state.title;
  }

  get seq(): number {
    return this.#seq;
  }

  get state(): SessionState {
    return this.#state;
  }

  get subagents(): SubagentMeta[] {
    return [...this.#subagents.values()];
  }

  /**
   * Fold one transcript line into the session.
   *
   * `agentId` is non-null when the line came from a subagent transcript. It is
   * required: those files carry the *parent's* sessionId, so without it every
   * agent's output would be attributed to the main thread.
   */
  ingest(line: string, agentId: string | null = null): IngestResult {
    const parsed = parseTranscriptEntry(line, { sessionId: this.sessionId, agentId });
    const events: NormalizedEvent[] = [];
    let stateDirty = false;

    if (parsed.ts) this.#lastKnownTs = parsed.ts;
    // Fall back to the last real timestamp, which may still be null on a
    // session's first line — an untimestamped `ai-title`, typically.
    const knownTs = parsed.ts ?? this.#lastKnownTs;
    const lastTs = knownTs ?? this.#state.updatedAt;

    for (const [key, value] of Object.entries(parsed.state)) {
      if (value === undefined || value === null) continue;
      const bag = this.#state as unknown as Record<string, unknown>;
      if (bag[key] !== value) {
        bag[key] = value;
        stateDirty = true;
      }
    }

    for (const draft of parsed.events) {
      events.push({ ...draft, seq: this.#seq++ } as NormalizedEvent);
      this.#lastEventAt = Date.now();
    }

    // A title change is a real event; a repeat of the same title is not.
    const title = this.#state.title;
    if (title && title !== this.#lastTitle) {
      this.#lastTitle = title;
      stateDirty = true;
      if (knownTs) events.push(this.#titleEvent(title, knownTs));
      else this.#pendingTitle = title;
    } else if (this.#pendingTitle && knownTs) {
      // A timestamp is finally available for a title we already knew about.
      events.push(this.#titleEvent(this.#pendingTitle, knownTs));
      this.#pendingTitle = null;
    }

    for (const signal of parsed.agents) {
      if (signal.kind === 'spawned') {
        if (this.#seenAgents.has(signal.agentId)) continue;
        this.#seenAgents.add(signal.agentId);
        if (signal.model) this.#models.set(signal.agentId, signal.model);

        // `agentId` is the subagent itself here, not a producer — see EventBase.
        // parentAgentId and spawnDepth are still unknown until the agent's
        // meta.json is read; the tree published in subagents.json is what
        // carries the authoritative nesting.
        events.push({
          seq: this.#seq++,
          ts: lastTs,
          sessionId: this.sessionId,
          agentId: signal.agentId,
          kind: 'subagent_start',
          agentType: 'unknown',
          description: signal.description,
          ...(signal.model ? { model: signal.model } : {}),
          parentAgentId: null,
          spawnDepth: 1,
          toolUseId: signal.toolUseId,
        });
        stateDirty = true;
      } else {
        const target = signal.agentId;
        if (target && this.#statuses.get(target) === 'running') continue;
        this.#statuses.set(target ?? '', 'completed');
        events.push({
          seq: this.#seq++,
          ts: lastTs,
          sessionId: this.sessionId,
          agentId: target ?? '',
          kind: 'subagent_stop',
          status: 'completed',
        });
        stateDirty = true;
      }
    }

    // Advance last-activity, but never move it backwards: lines from a subagent
    // transcript can interleave with the main thread's out of order.
    if (parsed.ts && parsed.ts > this.#state.updatedAt) {
      this.#state.updatedAt = parsed.ts;
    }

    return { events, state: this.#state, stateDirty };
  }

  /**
   * Fold in an `agent-<id>.meta.json`.
   *
   * This is the only source of `parentAgentId` and the true `spawnDepth`, so it
   * has to arrive before the tree is published.
   */
  registerSubagentMeta(raw: unknown, agentIdFromPath: string): boolean {
    const meta = parseSubagentMeta(raw, agentIdFromPath);
    if (!meta) return false;

    const existing = this.#subagents.get(meta.agentId);
    if (existing && sameMeta(existing, meta)) return false;

    this.#subagents.set(meta.agentId, meta);
    if (!this.#statuses.has(meta.agentId)) this.#statuses.set(meta.agentId, 'running');
    return true;
  }

  markSubagentStatus(agentId: string, status: SubagentStatus): boolean {
    if (this.#statuses.get(agentId) === status) return false;
    this.#statuses.set(agentId, status);
    return true;
  }

  /** Merge live liveness from the session registry, which transcripts cannot tell us. */
  applyRegistry(entry: RegistryEntry | null, controllable: boolean): boolean {
    let dirty = false;

    // No registry entry means no live process, so the session has ended. The
    // registry is authoritative: a transcript outlives the process that wrote it.
    const status: SessionStatus = entry ? registryStatus(entry) : 'ended';
    if (this.#state.status !== status) {
      this.#state.status = status;
      dirty = true;
    }
    const waiting = entry?.waitingFor ?? null;
    if (this.#state.waitingFor !== waiting) {
      this.#state.waitingFor = waiting;
      dirty = true;
    }
    if (entry?.cwd && this.#state.project !== entry.cwd) {
      this.#state.project = entry.cwd;
      dirty = true;
    }
    if (this.#state.controllable !== controllable) {
      this.#state.controllable = controllable;
      dirty = true;
    }

    return dirty;
  }

  /** The subagent forest, nested by `parentAgentId`. */
  subagentTree(): SubagentNode[] {
    return buildSubagentTree(this.subagents, {
      sessionId: this.sessionId,
      statuses: this.#statuses,
      models: this.#models,
    });
  }

  /**
   * Append an event originated by the bridge rather than read from a transcript.
   *
   * Keeps sequencing in one place: injection outcomes interleave with transcript
   * events and must share the same monotonic counter, or the phone sees gaps.
   */
  record(draft: Omit<InjectionEvent, 'seq'>): NormalizedEvent {
    const event = { ...draft, seq: this.#seq++ } as NormalizedEvent;
    this.#lastEventAt = Date.now();
    return event;
  }

  #titleEvent(title: string, ts: string): NormalizedEvent {
    return {
      seq: this.#seq++,
      ts,
      sessionId: this.sessionId,
      agentId: null,
      kind: 'title',
      title,
      source: 'ai',
    };
  }

  /** Milliseconds since the last event, for deciding idle vs active. */
  idleFor(now = Date.now()): number {
    return this.#lastEventAt === 0 ? Number.POSITIVE_INFINITY : now - this.#lastEventAt;
  }
}

function registryStatus(entry: RegistryEntry): SessionStatus {
  const status = (entry.rawStatus ?? '').toLowerCase();
  const waiting = (entry.waitingFor ?? '').toLowerCase();

  if (waiting) return 'waiting';
  if (status === 'waiting' || status === 'blocked') return 'waiting';
  if (status === 'active' || status === 'working' || status === 'busy') return 'active';
  if (status === 'ended' || status === 'exited' || status === 'stopped') return 'ended';
  return 'idle';
}

function sameMeta(a: SubagentMeta, b: SubagentMeta): boolean {
  return (
    a.agentType === b.agentType &&
    a.description === b.description &&
    a.parentAgentId === b.parentAgentId &&
    a.spawnDepth === b.spawnDepth &&
    a.toolUseId === b.toolUseId
  );
}
