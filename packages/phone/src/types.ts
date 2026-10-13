/**
 * The wire contract with the bridge.
 *
 * These mirror `packages/shared/src/types.ts` on the PC side. They are duplicated
 * rather than imported: the phone is deployed on its own (a static PWA) and has
 * no build-time dependency on the workspace.
 */

export type SessionStatus = 'active' | 'waiting' | 'idle' | 'ended';

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
  version: number;
  generatedAt: string;
  sessions: SessionIndexEntry[];
  /**
   * Whether the PC will deliver prompts at all.
   *
   * Distinct from a session's `controllable`: the PC can own a session's
   * terminal while still refusing prompts. Absent on an older index, and
   * deliberately not defaulted to true — an unknown policy is not permission.
   */
  injectionEnabled?: boolean;
}

export interface CostState {
  totalCostUSD: number;
  totalAPIDurationMs: number;
  totalToolDurationMs: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  models: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      costUSD: number;
    }
  >;
}

/**
 * The per-session file polled while that session is open.
 *
 * It carries the chunk range as well as the state, which is what lets the
 * reader work without a file listing: chunks are immutable and numbered, so
 * knowing which numbers exist is enough to fetch whatever is missing. It is
 * deliberately tiny — one of these is fetched on every poll.
 */
export interface SessionHead {
  sessionId: string;
  project: string | null;
  title: string | null;
  status: SessionStatus;
  /** Set only while `status` is `waiting`; the reason the session needs you. */
  waitingFor: string | null;
  model: string | null;
  gitBranch: string | null;
  controllable: boolean;
  cost?: CostState;
  updatedAt: string;
  /** Lowest chunk number still retained. Above 1 means history was pruned. */
  chunkFirst: number;
  /**
   * Highest chunk number that contains events.
   *
   * `chunkLast < chunkFirst` means the session has recorded nothing yet, so the
   * reader must fetch nothing rather than request a chunk that does not exist.
   */
  chunkLast: number;
  /** Lowest retained event sequence. */
  firstSeq: number;
  /** Highest event sequence written. */
  lastSeq: number;
  /** Bytes currently retained for this session. */
  retainedBytes: number;
  /** Events dropped by rolling retention, so the reader can say so plainly. */
  droppedEvents: number;
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface SubagentNode {
  agentId: string;
  agentType: string;
  description: string;
  toolUseId: string;
  parentAgentId: string | null;
  spawnDepth: number;
  sessionId: string;
  status: SubagentStatus;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  children: SubagentNode[];
}

/**
 * Terminating line of every chunk.
 *
 * Its absence means the chunk has not been sealed — the writer is still
 * appending to it, so it is discarded and refetched later rather than
 * half-believed. Its presence is also the reader's only integrity anchor now
 * that no manifest exists: `crc32` covers `${firstSeq}:${lines}` for the chunk
 * it terminates, which lets the reader check the body against the sentinel
 * without knowing anything the writer did not publish.
 */
export interface ChunkEndSentinel {
  t: 'chunk_end';
  n: number;
  lines: number;
  crc32: string;
}

// ---------------------------------------------------------------------------
// Events
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
  seq: number;
  ts: string;
  sessionId: string;
  agentId: string | null;
  kind: EventKind;
}

export type EditTool = 'Edit' | 'Write' | 'NotebookEdit' | 'MultiEdit';
export type InjectionState = 'accepted' | 'queued' | 'delivered' | 'dropped' | 'rejected';
export type AttentionLevel = 'info' | 'waiting' | 'error';

export interface UserPromptEvent extends EventBase {
  kind: 'user_prompt';
  text: string;
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
  patch?: string;
  added?: number;
  removed?: number;
  created?: boolean;
}

export interface SubagentStartEvent extends EventBase {
  kind: 'subagent_start';
  agentId: string;
  agentType: string;
  description: string;
  model?: string;
  parentAgentId: string | null;
  spawnDepth: number;
  toolUseId: string;
}

export interface SubagentStopEvent extends EventBase {
  kind: 'subagent_stop';
  agentId: string;
  status: SubagentStatus;
  durationMs?: number;
}

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
  source: string;
}

export interface AttentionEvent extends EventBase {
  kind: 'attention';
  text: string;
  level: AttentionLevel;
}

export interface InjectionEvent extends EventBase {
  kind: 'injection';
  promptId: string;
  state: InjectionState;
  detail?: string;
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

/** A prompt the phone wrote to `relay-in`, and what we have seen happen to it. */
export interface OutboundPrompt {
  promptId: string;
  sessionId: string;
  ts: string;
  text: string;
  /** Path inside the repo, for display. */
  path: string;
  /** Set once an `injection` event carrying this promptId appears in the stream. */
  acknowledged?: InjectionState;
  ackDetail?: string;
}
