/**
 * Chunk parsing and stream assembly.
 *
 * Two integrity rules from the writer shape everything here:
 *
 *  - Every sealed chunk ends with a `{"t":"chunk_end"}` sentinel. Its absence
 *    means the chunk is still being written (or was torn by a crash), so it is
 *    discarded and refetched rather than half-believed.
 *  - `manifest.json` records a sequence range per chunk. The ranges must join up
 *    (`lastSeq[n] + 1 === firstSeq[n + 1]`); a break means events were lost, and
 *    the reader resyncs from the last good chunk instead of rendering a timeline
 *    with a silent hole in it.
 */

import type { ChunkEndSentinel, ChunkEntry, NormalizedEvent } from '@/types';

import { crc32, sha256Hex, utf8Bytes } from './encoding';

export type ChunkRejection =
  | 'ok'
  | 'empty'
  | 'no-sentinel'
  | 'torn-line'
  | 'trailing-after-sentinel'
  | 'line-count-mismatch'
  | 'chunk-number-mismatch'
  | 'seq-mismatch'
  | 'checksum-mismatch';

export interface ChunkParse {
  ok: boolean;
  events: NormalizedEvent[];
  sentinel: ChunkEndSentinel | null;
  reason: ChunkRejection;
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
 * `entry` is the manifest record when there is one; passing it turns on the
 * checks the manifest makes possible (line count, sequence range, CRC-32).
 */
export function parseChunk(text: string, entry?: ChunkEntry): ChunkParse {
  const lines = text.split('\n');
  const events: NormalizedEvent[] = [];
  let sentinel: ChunkEndSentinel | null = null;
  let trailing = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A partial line only ever comes from a chunk the writer had not sealed.
      return { ok: false, events, sentinel, reason: 'torn-line' };
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

  if (trailing) return { ok: false, events: [], sentinel, reason: 'trailing-after-sentinel' };
  if (sentinel === null) return { ok: false, events: [], sentinel: null, reason: 'no-sentinel' };
  if (events.length === 0) return { ok: false, events: [], sentinel, reason: 'empty' };

  if (entry) {
    if (sentinel.n !== entry.n) {
      return { ok: false, events: [], sentinel, reason: 'chunk-number-mismatch' };
    }
    if (sentinel.lines !== events.length || entry.lines !== events.length) {
      return { ok: false, events: [], sentinel, reason: 'line-count-mismatch' };
    }
    const first = events[0]!.seq;
    const last = events[events.length - 1]!.seq;
    if (first !== entry.firstSeq || last !== entry.lastSeq) {
      return { ok: false, events: [], sentinel, reason: 'seq-mismatch' };
    }
    // The sentinel's CRC covers the manifest's own claim about the chunk, so it
    // detects a manifest and a chunk that disagree.
    const expected = crc32(utf8Bytes(`${entry.firstSeq}:${entry.lastSeq}:${entry.lines}`));
    if (expected !== sentinel.crc32) {
      return { ok: false, events: [], sentinel, reason: 'checksum-mismatch' };
    }
  }

  return { ok: true, events, sentinel, reason: 'ok' };
}

/**
 * Verify a chunk's SHA-256 against the manifest.
 *
 * Returns null when the digest cannot be checked (no Web Crypto, i.e. an
 * insecure origin): unverifiable is not the same as verified, so callers must
 * not treat null as a pass or a failure.
 */
export async function verifyChunkDigest(text: string, entry: ChunkEntry): Promise<boolean | null> {
  const digest = await sha256Hex(utf8Bytes(text));
  if (digest === null) return null;
  return digest === entry.sha256;
}

export interface LoadedChunk {
  entry: ChunkEntry;
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
 * parallel fetches the arrival order means nothing.
 */
export function assembleStream(chunks: readonly LoadedChunk[]): Assembled {
  const ordered = [...chunks].sort((a, b) => a.entry.n - b.entry.n);

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

/**
 * The first chunk that does not follow the previous one, if any.
 *
 * Runs against the manifest alone, so a break is detected before spending any
 * requests on content we would have to throw away.
 */
export function findManifestBreak(entries: readonly ChunkEntry[]): ChunkEntry | null {
  const ordered = [...entries].sort((a, b) => a.n - b.n);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.firstSeq !== previous.lastSeq + 1) return current;
  }
  return null;
}

/** Chunk numbers that the manifest implies but which are not present. */
export function findMissingChunks(entries: readonly ChunkEntry[]): number[] {
  const ordered = [...entries].sort((a, b) => a.n - b.n);
  const missing: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    for (let n = previous.n + 1; n < current.n; n++) missing.push(n);
  }
  return missing;
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
