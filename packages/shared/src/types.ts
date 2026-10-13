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
