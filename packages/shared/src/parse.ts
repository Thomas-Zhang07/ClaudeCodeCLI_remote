/**
 * Transcript entry -> normalized events.
 *
 * Pure and stateless: same input, same output, no file or network access. The
 * bridge supplies the context (which session and agent the line came from) and
 * owns all sequencing.
 *
 * Only what the phone needs comes out of here — chat text, file edits, and
 * subagent lifecycle signals. Thinking blocks, non-edit tool calls, tool
 * results, and attachments are dropped on purpose. The attachments matter most:
 * `prompt_snapshot` alone is ~44% of transcript bytes and embeds the entire
 * system prompt plus every tool definition, so truncating it rather than
 * dropping it would push kilobytes of pure noise to the relay on repeat.
 */

import { clipPatch, clipProse, clipShort, BUDGETS, truncateText } from './truncate.js';
import { redactText } from './redact.js';
import type { EditTool, EventDraft, SessionState } from './types.js';

/** An edit before the bridge assigns its sequence number. */
type EditDraft = Extract<EventDraft, { kind: 'edit' }>;

// ---------------------------------------------------------------------------
// Classification tables
// ---------------------------------------------------------------------------

/** Attachment subtypes that are large, repetitive, and carry nothing for a phone. */
export const DENYLISTED_ATTACHMENTS: ReadonlySet<string> = new Set([
  'prompt_snapshot',
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_record',
  'queued_command',
]);

/**
 * Entry types Claude Code treats as "last-wins": they describe current state
 * rather than an event, so they belong in `state.json` and must never reach the
 * timeline. Listed for documentation and for the bridge's routing.
 */
export const LAST_WINS_TYPES: ReadonlySet<string> = new Set([
  'mode',
  'permission-mode',
  'atis-latch',
  'cost-state',
  'queue-operation',
  'ai-title',
  'custom-title',
  'agent-name',
  'agent-color',
  'tag',
  'relocated',
  'worktree-state',
  'isolation-latch',
  'history-suppression',
  'bridge-session',
  'dev-mods',
  'summary',
  'ended-by-model',
  'observer-ref',
  'pr-link',
  'last-prompt',
]);

/** Tools whose results carry a diff. Exported for the bridge and tests. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set<EditTool>([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

/** Tools that spawn a subagent. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** Entry types we never even look inside. */
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'mode',
  'permission-mode',
  'queue-operation',
  'summary',
  'relocated',
  'worktree-state',
]);

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface ParseContext {
  sessionId: string;
  /** Which agent this line belongs to; null for the main thread. */
  agentId: string | null;
}

/**
 * A subagent lifecycle signal.
 *
 * Deliberately *not* turned into an event here: `parentAgentId` and
 * `spawnDepth` are not in the transcript at all — they live in the agent's
 * `meta.json` — so the bridge resolves the tree and rewrites the draft before
 * publishing.
 */
export type AgentSignal =
  | {
      kind: 'spawned';
      agentId: string;
      description: string;
      model?: string;
      toolUseId: string;
    }
  | {
      /** A `<agent-message>` hand-back: this is how a subagent's completion arrives. */
      kind: 'handback';
      agentId: string | null;
      text: string;
      agentName: string | null;
    };

export interface ParsedEntry {
  events: EventDraft[];
  state: Partial<SessionState>;
  agents: AgentSignal[];
  /** Set when the line could not be used, for diagnostics. */
  skipped?: string;
}

const EMPTY: ParsedEntry = { events: [], state: {}, agents: [] };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse one transcript line.
 *
 * Accepts a raw line (including a leading BOM or NUL padding) or an already
 * decoded object. Malformed input yields no events rather than throwing —
 * a single bad line must not stall the tail.
 */
export function parseTranscriptEntry(raw: string | unknown, ctx: ParseContext): ParsedEntry {
  let entry: Record<string, unknown>;

  if (typeof raw === 'string') {
    // Strip a BOM and any NUL padding. The harness tolerates NUL-prefixed
    // records and writes them, so a raw line can legitimately begin with them —
    // and `String.prototype.trim` does not remove NUL.
    const trimmed = raw.replace(/^[﻿\u0000]+/, '').trim();
    if (!trimmed) return EMPTY;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...EMPTY, skipped: 'not-an-object' };
      }
      entry = parsed as Record<string, unknown>;
    } catch {
      return { ...EMPTY, skipped: 'invalid-json' };
    }
  } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    entry = raw as Record<string, unknown>;
  } else {
    return { ...EMPTY, skipped: 'not-an-object' };
  }

  const type = str(entry['type']);
  if (!type) return { ...EMPTY, skipped: 'no-type' };
  if (IGNORED_TYPES.has(type)) return EMPTY;

  const ts = str(entry['timestamp']) ?? new Date(0).toISOString();
  const base = { ts, sessionId: ctx.sessionId, agentId: ctx.agentId };
  const events: EventDraft[] = [];
  const state: Partial<SessionState> = {};
  const agents: AgentSignal[] = [];

  // Context present on message-bearing entries.
  const cwd = str(entry['cwd']);
  if (cwd) state.project = cwd;
  const branch = str(entry['gitBranch']);
  if (branch) state.gitBranch = branch;

  switch (type) {
    case 'assistant':
      collectAssistant(entry, base, events, state);
      break;
    case 'user':
      collectUser(entry, base, events, agents);
      break;
    case 'system':
      collectSystem(entry, base, events);
      break;
    case 'cost-state':
      state.cost = readCostState(entry);
      break;
    case 'ai-title':
    case 'custom-title':
    case 'agent-name':
      collectTitle(entry, state);
      break;
    case 'attachment':
      collectAttachment(entry, state);
      break;
    case 'last-prompt':
      // A ready-made list subtitle; no transcript parsing needed.
      break;
    default:
      // Unknown types are ignored rather than guessed at. New entry types appear
      // with CLI releases and must not break the tail.
      break;
  }

  return { events, state, agents };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

type Base = { ts: string; sessionId: string; agentId: string | null };

function collectAssistant(
  entry: Record<string, unknown>,
  base: Base,
  events: EventDraft[],
  state: Partial<SessionState>,
): void {
  const message = obj(entry['message']);
  if (!message) return;

  const model = str(message['model']);
  if (model) state.model = model;

  const content = message['content'];
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObj(block)) continue;
    const kind = str(block['type']);

    if (kind === 'text') {
      const text = str(block['text']);
      if (!text) continue;
      const clipped = clipProse(redactText(text));
      if (!clipped.trim()) continue;
      events.push({ ...base, kind: 'assistant_text', text: clipped, ...(model ? { model } : {}) });
      continue;
    }

    if (kind === 'tool_use') {
      // Tool *calls* are deliberately not turned into events:
      //   - an edit is emitted from its tool result, which carries the real diff
      //   - a spawned subagent's `agentId` arrives on the result, not the call
      //   - every other tool is outside this project's "chat text and edits" scope
      continue;
    }

    // `thinking` and anything else: dropped by design.
  }
}

function collectUser(
  entry: Record<string, unknown>,
  base: Base,
  events: EventDraft[],
  agents: AgentSignal[],
): void {
  const message = obj(entry['message']);
  if (!message) return;
  const content = message['content'];

  // A plain string is a typed prompt.
  if (typeof content === 'string') {
    pushUserPrompt(content, entry, base, events);
    return;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObj(block)) continue;
      // `tool_result` blocks carry no text worth publishing — the interesting
      // part of a tool result is on the entry's `toolUseResult`, read below.
      if (str(block['type']) !== 'text') continue;
      const text = str(block['text']);
      if (text) pushUserPrompt(text, entry, base, events);
    }
  }

  // The edit diff lives here, on the result, not on the call.
  const result = obj(entry['toolUseResult']);
  if (result) {
    const edit = readEditResult(result, entry, base);
    if (edit) events.push(edit);

    const spawned = readAgentResult(result);
    if (spawned) agents.push(spawned);
  }
}

function pushUserPrompt(
  text: string,
  entry: Record<string, unknown>,
  base: Base,
  events: EventDraft[],
): void {
  const clean = redactText(text).trim();
  if (!clean) return;

  // Skip synthetic content the harness injects as a user turn.
  if (/^<(?:system-reminder|command-name|local-command)/.test(clean)) return;

  const origin = obj(entry['origin']);
  if (origin && str(origin['kind']) && str(origin['kind']) !== 'human') return;

  events.push({
    ...base,
    kind: 'user_prompt',
    text: truncateText(clean, BUDGETS.userPrompt),
  });

  // A prompt opens a turn. The end arrives later as a `turn_duration` entry.
  const promptId = str(entry['promptId']) ?? str(entry['uuid']) ?? base.ts;
  events.push({ ...base, kind: 'turn_start', turnId: promptId });
}

function collectSystem(
  entry: Record<string, unknown>,
  base: Base,
  events: EventDraft[],
): void {
  const subtype = str(entry['subtype']);

  if (subtype === 'turn_duration') {
    const durationMs = num(entry['durationMs']) ?? 0;
    const messageCount = num(entry['messageCount']) ?? 0;
    events.push({
      ...base,
      kind: 'turn_end',
      turnId: str(entry['uuid']) ?? base.ts,
      durationMs,
      messageCount,
    });
    return;
  }

  if (subtype === 'compact_boundary') {
    events.push({
      ...base,
      kind: 'attention',
      text: 'Conversation compacted',
      level: 'info',
    });
    return;
  }
}

/**
 * Record a session title.
 *
 * Deliberately emits **no event**. `ai-title` is a last-wins type and re-fires
 * constantly — 1,669 occurrences across 37 real transcripts, roughly 45 per
 * session — so emitting one event each would bury the timeline in duplicates of
 * a value that only changes a handful of times.
 *
 * The parser is stateless and cannot tell a change from a repeat, so it records
 * the value and leaves emission to the bridge, which holds the previous title
 * and publishes a `title` event only when it actually differs.
 */
function collectTitle(
  entry: Record<string, unknown>,
  state: Partial<SessionState>,
): void {
  const title =
    str(entry['aiTitle']) ??
    str(entry['customTitle']) ??
    str(entry['agentName']) ??
    str(entry['title']);
  if (!title) return;

  state.title = clipShort(title, BUDGETS.description);
}

function collectAttachment(entry: Record<string, unknown>, state: Partial<SessionState>): void {
  const attachment = obj(entry['attachment']);
  if (!attachment) return;

  const subtype = str(attachment['type']) ?? '';
  if (DENYLISTED_ATTACHMENTS.has(subtype)) return;

  // The environment snapshot is the one attachment worth reading: it carries the
  // working directory, which is a better project label than the slug directory.
  if (subtype === 'environment') {
    const snapshot = obj(attachment['snapshot']);
    const wd = snapshot ? str(snapshot['workingDirectory']) : null;
    if (wd) state.project = wd;
  }
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

/**
 * Build an edit event from a `toolUseResult`.
 *
 * `structuredPatch` is the unified diff the phone renders, which is why edits
 * are read from the result rather than the call: the call only has the raw
 * old/new strings.
 */
function readEditResult(
  result: Record<string, unknown>,
  entry: Record<string, unknown>,
  base: Base,
): EditDraft | null {
  const filePath = str(result['filePath']);
  if (!filePath) return null;

  const hasOld = 'oldString' in result;
  const hasContent = 'content' in result;
  const patch = result['structuredPatch'];

  const isEdit = hasOld && patch !== undefined;
  const isWrite = hasContent && patch !== undefined;
  if (!isEdit && !isWrite) return null;

  const toolUseId = findToolUseId(entry) ?? str(entry['uuid']) ?? '';
  const rendered = renderPatch(patch);
  const { added, removed } = countChanges(rendered);

  const event: EditDraft = {
    ...base,
    kind: 'edit',
    toolUseId,
    tool: isWrite ? 'Write' : 'Edit',
    filePath: clipShort(redactText(filePath)),
  };

  if (rendered) event.patch = clipPatch(redactText(rendered));
  if (added) event.added = added;
  if (removed) event.removed = removed;
  if (isWrite && typeof result['originalFile'] === 'string' && result['originalFile'] === '') {
    event.created = true;
  }

  return event;
}

/** Recover the `agentId` from the async subagent launch result. */
function readAgentResult(result: Record<string, unknown>): AgentSignal | null {
  // A hand-back message, framed by the harness as `<agent-message from="...">`.
  const content = result['content'];
  if (typeof content === 'string' && content.includes('<agent-message')) {
    const from = /<agent-message[^>]*\bfrom="([^"]*)"/.exec(content);
    const name = /<agent-message[^>]*\bfrom-name="([^"]*)"/.exec(content);
    return {
      kind: 'handback',
      agentId: from?.[1] ?? null,
      agentName: name?.[1] ?? null,
      text: truncateText(redactText(content), BUDGETS.description),
    };
  }

  const agentId = str(result['agentId']);
  if (agentId) {
    return {
      kind: 'spawned',
      agentId,
      description: clipShort(str(result['description']) ?? 'subagent', BUDGETS.description),
      ...(str(result['resolvedModel']) ? { model: str(result['resolvedModel'])! } : {}),
      toolUseId: str(result['toolUseId']) ?? '',
    };
  }

  return null;
}

/** Pull the `tool_use_id` out of a tool_result block. */
function findToolUseId(entry: Record<string, unknown>): string | null {
  const source = str(entry['sourceToolAssistantUUID']);
  if (source) return source;

  const message = obj(entry['message']);
  const content = message?.['content'];
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (!isObj(block)) continue;
    if (str(block['type']) !== 'tool_result') continue;
    const id = str(block['tool_use_id']);
    if (id) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diff rendering
// ---------------------------------------------------------------------------

interface PatchHunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: unknown;
}

/**
 * Render a `structuredPatch` array into unified-diff text.
 *
 * The transcript stores hunks as structured objects; rendering them here keeps
 * the phone free of transcript-specific knowledge.
 */
export function renderPatch(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';

  const parts: string[] = [];
  for (const h of raw as PatchHunk[]) {
    if (!isObj(h)) continue;
    const oldStart = num(h.oldStart) ?? 0;
    const oldLines = num(h.oldLines) ?? 0;
    const newStart = num(h.newStart) ?? 0;
    const newLines = num(h.newLines) ?? 0;
    parts.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);

    if (Array.isArray(h.lines)) {
      for (const line of h.lines) {
        if (typeof line === 'string') parts.push(line);
      }
    }
  }
  return parts.join('\n');
}

function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export function readCostState(entry: Record<string, unknown>): SessionState['cost'] {
  const usage = obj(entry['modelUsage']) ?? {};
  const models: NonNullable<SessionState['cost']>['models'] = {};

  for (const [name, value] of Object.entries(usage)) {
    if (!isObj(value)) continue;
    models[name] = {
      inputTokens: num(value['inputTokens']) ?? 0,
      outputTokens: num(value['outputTokens']) ?? 0,
      cacheReadInputTokens: num(value['cacheReadInputTokens']) ?? 0,
      costUSD: num(value['costUSD']) ?? 0,
    };
  }

  return {
    totalCostUSD: num(entry['totalCostUSD']) ?? 0,
    totalAPIDurationMs: num(entry['totalAPIDuration']) ?? 0,
    totalToolDurationMs: num(entry['totalToolDuration']) ?? 0,
    totalLinesAdded: num(entry['totalLinesAdded']) ?? 0,
    totalLinesRemoved: num(entry['totalLinesRemoved']) ?? 0,
    models,
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function obj(v: unknown): Record<string, unknown> | null {
  return isObj(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
