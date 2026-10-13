/**
 * Chunk parsing and stream assembly.
 *
 * There is no manifest on the wire any more. Chunks are immutable, numbered and
 * contiguous, so the reader already knows a chunk's expected number, and the
 * terminating `{"t":"chunk_end"}` sentinel carries everything else it needs:
 *
 *  - **A missing sentinel means the chunk is not sealed yet.** The writer is
 *    still appending, so the chunk is discarded and refetched on a later poll —
 *    never half-believed. This is the normal state of the newest chunk while a
 *    turn is streaming, so it is not treated as an error.
 *  - **The sentinel's `crc32` covers `${firstSeq}:${lines}`** for the chunk it
 *    terminates. Computing that from the parsed body checks the body and the
 *    sentinel agree, which catches a truncated or duplicated chunk without any
 *    out-of-band digest.
 *
 * Sequence continuity is checked across chunks as before: a chunk whose events
 * do not continue the previous chunk's sequence is a real break, and everything
 * after it is withheld rather than rendered out of order.
 */

import type { ChunkEndSentinel, NormalizedEvent } from '@/types';

import { crc32, utf8Bytes } from './encoding';

export type ChunkRejection =
  | 'ok'
  | 'incomplete'
  | 'empty'
  | 'torn-line'
  | 'trailing-after-sentinel'
  | 'line-count-mismatch'
  | 'chunk-number-mismatch'
  | 'checksum-mismatch';

export interface ChunkParse {
  ok: boolean;
  events: NormalizedEvent[];
  sentinel: ChunkEndSentinel | null;
  reason: ChunkRejection;
  /**
   * True when the chunk has no sentinel: the writer has not sealed it yet.
   * Callers must treat this as "not ready", never as a gap or a corruption.
   */
  incomplete: boolean;
}

function isSentinel(value: unknown): value is ChunkEndSentinel {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return o['t'] === 'chunk_end';
}

function isEventLike(value: unknown): value is NormalizedEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o['seq'] === 'number' && typeof o['kind'] === 'string' && typeof o['ts'] === 'string';
}

/**
 * Parse one chunk file.
 *
 * `expectedN` is the number the reader asked for. Passing it checks the sentinel
 * against the request, which catches a mis-numbered file that would otherwise
 * assemble into the stream at the wrong position.
 */
export function parseChunk(text: string, expectedN?: number): ChunkParse {
  const lines = text.split('\n');
  const events: NormalizedEvent[] = [];
  let sentinel: ChunkEndSentinel | null = null;
  let torn = false;
  let trailing = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      torn = true;
      continue;
    }

    if (isSentinel(parsed)) {
      sentinel = parsed;
      continue;
    }
    if (sentinel !== null) {
      // Data after the sentinel means the sentinel was not the last line.
      trailing = true;
      continue;
    }
    if (isEventLike(parsed)) events.push(parsed);
  }

  if (sentinel === null) {
    // Unsealed. A torn final line is expected here — the writer may be mid-line
    // as we read — so this takes precedence over the torn-line verdict below.
    return { ok: false, events: [], sentinel: null, reason: 'incomplete', incomplete: true };
  }

  if (torn) return { ok: false, events: [], sentinel, reason: 'torn-line', incomplete: false };
  if (trailing) {
    return { ok: false, events: [], sentinel, reason: 'trailing-after-sentinel', incomplete: false };
  }
  if (events.length === 0) return { ok: false, events: [], sentinel, reason: 'empty', incomplete: false };

  if (expectedN !== undefined && sentinel.n !== expectedN) {
    return { ok: false, events: [], sentinel, reason: 'chunk-number-mismatch', incomplete: false };
  }
  if (sentinel.lines !== events.length) {
    return { ok: false, events: [], sentinel, reason: 'line-count-mismatch', incomplete: false };
  }

  // The writer seals over the chunk's own first sequence and line count; both
  // come from the body we just parsed, so this is checkable without a manifest.
  const expected = crc32(utf8Bytes(`${events[0]!.seq}:${sentinel.lines}`));
  if (expected !== sentinel.crc32) {
    return { ok: false, events: [], sentinel, reason: 'checksum-mismatch', incomplete: false };
  }

  return { ok: true, events, sentinel, reason: 'ok', incomplete: false };
}

/**
 * One chunk, ready to assemble.
 *
 * `n` replaces the old manifest record: it is all the reader knows about the
 * chunk, and it is enough, because the events carry their own sequences.
 */
export interface LoadedChunk {
  n: number;
  events: NormalizedEvent[];
}

export interface Assembled {
  events: NormalizedEvent[];
  /** Number of events dropped as duplicates or out-of-order repeats. */
  duplicatesDropped: number;
  /** Set when the sequence jumps: the seq expected but never seen. */
  gapAfterSeq: number | null;
  /** Everything from the gap onward is withheld, so the UI can say so. */
  truncatedAtGap: boolean;
  lastSeq: number | null;
}

/**
 * Concatenate chunks, dropping anything that does not continue the sequence.
 *
 * Chunks are sorted by their `n`, not trusted in the order they arrived: with
 * parallel or caught-up fetches the arrival order means nothing.
 */
export function assembleStream(chunks: readonly LoadedChunk[]): Assembled {
  const ordered = [...chunks].sort((a, b) => a.n - b.n);

  const events: NormalizedEvent[] = [];
  let duplicatesDropped = 0;
  let gapAfterSeq: number | null = null;
  let lastSeq: number | null = null;

  for (const chunk of ordered) {
    for (const event of chunk.events) {
      if (lastSeq !== null && event.seq <= lastSeq) {
        duplicatesDropped++;
        continue;
      }
      if (lastSeq !== null && event.seq !== lastSeq + 1) {
        gapAfterSeq = lastSeq;
        break;
      }
      events.push(event);
      lastSeq = event.seq;
    }
    if (gapAfterSeq !== null) break;
  }

  return {
    events,
    duplicatesDropped,
    gapAfterSeq,
    truncatedAtGap: gapAfterSeq !== null,
    lastSeq,
  };
}

export interface TimelineMeta {
  lastTurnEnd: { durationMs: number; messageCount: number; ts: string } | null;
  lastEventTs: string | null;
  model: string | null;
  latestAttention: { text: string; level: string; ts: string } | null;
  userPrompts: number;
  edits: number;
}

export function summarize(events: readonly NormalizedEvent[]): TimelineMeta {
  let lastTurnEnd: TimelineMeta['lastTurnEnd'] = null;
  let model: string | null = null;
  let latestAttention: TimelineMeta['latestAttention'] = null;
  let userPrompts = 0;
  let edits = 0;

  for (const event of events) {
    switch (event.kind) {
      case 'turn_end':
        lastTurnEnd = { durationMs: event.durationMs, messageCount: event.messageCount, ts: event.ts };
        break;
      case 'assistant_text':
        if (event.model) model = event.model;
        break;
      case 'attention':
        latestAttention = { text: event.text, level: event.level, ts: event.ts };
        break;
      case 'user_prompt':
        userPrompts++;
        break;
      case 'edit':
        edits++;
        break;
      default:
        break;
    }
  }

  return {
    lastTurnEnd,
    lastEventTs: events.length > 0 ? (events[events.length - 1]!.ts ?? null) : null,
    model,
    latestAttention,
    userPrompts,
    edits,
  };
}
