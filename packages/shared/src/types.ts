/**
 * The contract between the bridge and the phone.
 *
 * Everything here is deliberately small: these values are serialized into a git
 * repository that is polled over a mobile connection, so each one carries a byte
 * budget. See `truncate.ts`.
 */

// ---------------------------------------------------------------------------
// Events (the timeline)
// ---------------------------------------------------------------------------

export type EventKind =
  | 'user_prompt'
  | 'assistant_text'
  | 'edit'
  | 'subagent_start'
  | 'subagent_stop'
  | 'turn_start'
  | 'turn_end'
  | 'title'
  | 'attention'
  | 'injection';

export interface EventBase {
  /** Monotonic per session. Used by the phone to detect gaps between chunks. */
  seq: number;
  /** ISO-8601, from the transcript where available. */
  ts: string;
  sessionId: string;
  /**
   * The agent this event belongs to, or null for the main thread.
   *
   * Subagent transcripts carry the *parent's* sessionId, so sessionId alone
   * cannot distinguish them — this field is what keeps four concurrent agents
   * from being merged into one stream.
   *
   * For `subagent_start` and `subagent_stop` the event belongs to the subagent
   * itself rather than to a producer, so those two narrow it to a non-null id.
   * Every other kind reports where it came from.
   */
  agentId: string | null;
  kind: EventKind;
}

export interface UserPromptEvent extends EventBase {
  kind: 'user_prompt';
  text: string;
  /** True when this prompt originated from the phone rather than the keyboard. */
  injected?: boolean;
}

export interface AssistantTextEvent extends EventBase {
  kind: 'assistant_text';
  text: string;
  model?: string;
}

export interface EditEvent extends EventBase {
  kind: 'edit';
  toolUseId: string;
  tool: EditTool;
  filePath: string;
  /** Unified diff text, already truncated. Absent for a whole-file write. */
  patch?: string;
  added?: number;
  removed?: number;
  /** True when the tool wrote a new file rather than modifying one. */
  created?: boolean;
}

export type EditTool = 'Edit' | 'Write' | 'NotebookEdit' | 'MultiEdit';

export interface SubagentStartEvent extends EventBase {
  kind: 'subagent_start';
  agentId: string;
  agentType: string;
  description: string;
  model?: string;
  /** The agent that spawned this one, or null when spawned by the main thread. */
  parentAgentId: string | null;
  spawnDepth: number;
  /** The `tool_use` id of the spawning Agent call — anchors the card in the timeline. */
  toolUseId: string;
}

export interface SubagentStopEvent extends EventBase {
  kind: 'subagent_stop';
  agentId: string;
  status: SubagentStatus;
  durationMs?: number;
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface TurnStartEvent extends EventBase {
  kind: 'turn_start';
  turnId: string;
}

export interface TurnEndEvent extends EventBase {
  kind: 'turn_end';
  turnId: string;
  durationMs: number;
  messageCount: number;
}

export interface TitleEvent extends EventBase {
  kind: 'title';
  title: string;
  source: 'ai' | 'custom' | 'agent-name';
}

export interface AttentionEvent extends EventBase {
  kind: 'attention';
  text: string;
  level: AttentionLevel;
}

export type AttentionLevel = 'info' | 'waiting' | 'error';

/**
 * The outcome of a prompt the phone sent.
 *
 * Claude Code queues prompts delivered mid-turn, and queued commands can be
 * discarded. We never report `delivered` unless the transcript confirms the
 * prompt actually landed.
 */
export interface InjectionEvent extends EventBase {
  kind: 'injection';
  promptId: string;
  state: InjectionState;
  detail?: string;
}

export type InjectionState = 'accepted' | 'queued' | 'delivered' | 'dropped' | 'rejected';

/**
 * Kinds the bridge synthesizes about its own bookkeeping, rather than reading
 * from a transcript.
 *
 * This distinction is load-bearing for the injection guard, which asks what the
 * session's main thread last *did*. Recording a prompt's fate used to overwrite
 * that answer: a refusal appended an `injection` event, the session then looked
 * permanently mid-turn, and refusing again appended another — so one failed
 * prompt locked remote entry for that session for good.
 *
 * A denylist rather than an allowlist, deliberately. An unrecognised kind is
 * far safer treated as real transcript activity: that only ever makes the guard
 * more reluctant, whereas wrongly ignoring real activity could let a prompt be
 * typed mid-turn.
 */
export const SYNTHESIZED_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'title',
  'attention',
  'injection',
]);

/** True when an event came from a transcript rather than the bridge itself. */
export function isTranscriptEvent(kind: EventKind): boolean {
  return !SYNTHESIZED_KINDS.has(kind);
}

export type NormalizedEvent =
  | UserPromptEvent
  | AssistantTextEvent
  | EditEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | TurnStartEvent
  | TurnEndEvent
  | TitleEvent
  | AttentionEvent
  | InjectionEvent;

/**
 * An event before the bridge assigns its sequence number.
 *
 * `Omit` on a union collapses to the keys every member shares, which would throw
 * away every payload field, so the conditional is required to distribute it.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventDraft = DistributiveOmit<NormalizedEvent, 'seq'>;

// ---------------------------------------------------------------------------
// Session state (last-wins — never part of the timeline)
// ---------------------------------------------------------------------------

/**
 * Claude Code classifies certain transcript entries as "last-wins": they
 * describe the current state of the world rather than something that happened.
 * These go here and must never be emitted as timeline events.
 */
export interface SessionState {
  sessionId: string;
  /** Best-known project directory. Display only — never use this as a key. */
  project: string | null;
  title: string | null;
  status: SessionStatus;
  /** Human-readable reason when status is `waiting`, from the session registry. */
  waitingFor: string | null;
  model: string | null;
  gitBranch: string | null;
  /** True when the bridge owns this session's stdin and can inject prompts. */
  controllable: boolean;

  cost?: CostState;
  /** Highest chunk number the phone may safely read. */
  chunkLast?: number;
  updatedAt: string;
}

export type SessionStatus = 'active' | 'waiting' | 'idle' | 'ended';

/**
 * The per-session file the reader polls while a session is open.
 *
 * Separate from the session list because the two change at different rates and
 * are read at different times: the list is loaded once while browsing, this is
 * polled only for the session actually on screen. A single combined index would
 * make every session's activity invalidate the cache of a reader watching one.
 *
 * Carries the chunk range so the reader never needs a file listing — chunks are
 * immutable and sequential, so knowing which numbers exist is enough.
 */
export interface SessionHead extends SessionState {
  /**
   * When the bridge last wrote this file.
   *
   * Deliberately not `updatedAt`: that is the *session's* clock and stops moving
   * the moment the session goes idle, so it cannot answer "is the bridge still
   * publishing?". This one is rewritten on every write, whatever the session is
   * doing.
   */
  heartbeat?: string;
  /** Lowest chunk number still retained. Above 1 means history was pruned. */
  chunkFirst: number;
  /**
   * Highest chunk number that actually contains events.
   *
   * `chunkLast < chunkFirst` means the session has recorded nothing yet — fetch
   * nothing, rather than requesting a chunk that does not exist.
   */
  chunkLast: number;
  /** Lowest event sequence still retained. */
  firstSeq: number;
  /** Highest event sequence written. */
  lastSeq: number;
  /** Bytes currently retained for this session. */
  retainedBytes: number;
  /** Events dropped by retention, so the reader can say so plainly. */
  droppedEvents: number;
  /**
   * Identifies this run of a session's chunk series.
   *
   * Chunk *numbers* are not stable across a rebuild: clearing the output
   * directory restarts the series at chunk 1, so `events-0001.jsonl` can go from
   * holding 398 events to holding 49 while keeping its name. A reader that
   * caches by path then serves the old bytes under a key that never changed, and
   * reports a stream gap that does not exist.
   *
   * So a cached chunk is only valid within the generation it was fetched from.
   * The token is opaque, minted when the writer first creates a session's output
   * directory, and stable for as long as that series of chunks lives — it
   * changes on a rebuild and on nothing else.
   *
   * Optional on the wire, and **absent means "assume it matches"**: a reader
   * must keep working against a bridge too old to publish it. That fallback is
   * the weaker path — it is exactly the stale-cache hazard above — and exists
   * only for compatibility.
   */
  generation?: string;
}

export interface CostState {
  totalCostUSD: number;
  totalAPIDurationMs: number;
  totalToolDurationMs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  models: Record<string, ModelUsage>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/** What `<sessionId>/subagents/agent-<agentId>.meta.json` contains. */
export interface SubagentMeta {
  agentId: string;
  agentType: string;
  description: string;
  /** The Agent tool_use that spawned this agent. */
  toolUseId: string;
  /** The spawning agent, when a subagent spawned a subagent. */
  parentAgentId: string | null;
  spawnDepth: number;
  requestShape?: string;
}

/** Metadata-only view published to the phone. Subagent chat text is not sent. */
export interface SubagentNode extends SubagentMeta {
  sessionId: string;
  model?: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  /** Nested by parentAgentId — the directory layout is flat and cannot be used. */
  children: SubagentNode[];
}

// ---------------------------------------------------------------------------
// The relay repo
// ---------------------------------------------------------------------------

export interface SessionIndexEntry {
  sessionId: string;
  project: string | null;
  title: string | null;
  status: SessionStatus;
  updatedAt: string;
  lastSeq: number;
  controllable: boolean;
  costUSD?: number;
}

export interface RelayIndex {
  /** Bumped when the on-disk layout changes, so old phones fail loudly. */
  version: number;
  generatedAt: string;
  /**
   * When the bridge last wrote this file.
   *
   * A *liveness* signal, distinct from `generatedAt`: both move together here,
   * but the field exists so the reader has one thing to look for in every file
   * the bridge publishes, and never has to reason about which timestamp in
   * which file means "the writer is still alive".
   *
   * The phone needs it because Gitee answers `200` for hours after the bridge
   * stops — reachable is not the same as alive, and claiming `live` from a
   * successful request is a claim the phone cannot support.
   */
  heartbeat?: string;
  sessions: SessionIndexEntry[];
  /**
   * Whether the bridge will actually deliver prompts.
   *
   * Separate from a session's `controllable`: a session can be launchable from
   * the phone and still refuse prompts, because injection is a policy the
   * operator sets. Publishing it lets the phone explain a refusal instead of
   * leaving prompts sitting unacknowledged with no visible reason.
   */
  injectionEnabled?: boolean;
}

export interface ChunkEntry {
  n: number;
  sha256: string;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  lines: number;
}

export interface ChunkManifest {
  sessionId: string;
  chunks: ChunkEntry[];
}

/** Terminating line of every chunk. Its absence means the chunk is torn. */
export interface ChunkEndSentinel {
  t: 'chunk_end';
  n: number;
  lines: number;
  crc32: string;
}

/** A prompt written by the phone. */
export interface InboundPrompt {
  version: 1;
  sessionId: string;
  promptId: string;
  /** ISO-8601. Rejected when too old, so a stale file cannot be replayed. */
  ts: string;
  text: string;
  /** Hex HMAC-SHA256 over `${sessionId}\n${ts}\n${promptId}\n${text}`. */
  sig: string;
}
