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

export interface SessionState {
  sessionId: string;
  project: string | null;
  title: string | null;
  status: SessionStatus;
  waitingFor: string | null;
  model: string | null;
  gitBranch: string | null;
  controllable: boolean;
  cost?: CostState;
  chunkLast?: number;
  updatedAt: string;
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

/** The raw shape of a trees/blob listing entry. */
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | string;
  sha: string;
  size?: number;
}
