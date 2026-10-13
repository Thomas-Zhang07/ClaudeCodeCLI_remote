/**
 * Byte budgets.
 *
 * Transcript entries reach hundreds of kilobytes — a single attachment line has
 * been measured at 239 KB — and the whole relay repo is polled over a mobile
 * connection. Every string that leaves the bridge is cut to a known ceiling here
 * so the phone can rely on a bound regardless of what the transcript contained.
 *
 * Budgets are in UTF-8 **bytes**, not characters, because that is what actually
 * costs bandwidth: a CJK character is three bytes, so a Chinese prompt hits the
 * ceiling three times sooner than an English one of the same length.
 */

export const BUDGETS = {
  /** A user prompt. Kept generous — this is the user's own text. */
  userPrompt: 8_000,
  /** An assistant reply. */
  assistantText: 8_000,
  /** A unified diff. Larger than prose because diffs are the point. */
  patch: 12_000,
  /** A file path, a model id, an agent type. */
  short: 512,
  /** A subagent description. */
  description: 400,
  /** A status line or attention message. */
  message: 1_000,
} as const;

/** Truncation marker, e.g. `… [+12345 bytes]`. */
function marker(dropped: number): string {
  return `… [+${dropped} bytes]`;
}

/** Room held back for the marker before we know how wide it will be. */
const MARKER_RESERVE = 32;

/**
 * Decode the longest prefix that is at most `maxBytes` of UTF-8.
 *
 * Backs off to a code-point boundary: continuation bytes match 10xxxxxx, so
 * walking back over them avoids emitting a replacement glyph for a character
 * that was merely cut in half.
 */
function decodePrefix(buf: Buffer, maxBytes: number): string {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Cut a string to at most `maxBytes` of UTF-8, appending a marker.
 *
 * The result is **guaranteed** not to exceed `maxBytes`. Chunk-size enforcement
 * relies on that, so the marker is fitted rather than assumed: its width depends
 * on how much was dropped, which depends on how much we kept, so we converge in
 * a few passes and fall back to a markerless cut when the budget is too small to
 * hold any marker at all.
 *
 * Never splits a multi-byte sequence.
 */
export function truncateText(input: string, maxBytes: number): string {
  if (!input) return input;
  if (maxBytes <= 0) return '';

  const size = Buffer.byteLength(input, 'utf8');
  if (size <= maxBytes) return input;

  const buf = Buffer.from(input, 'utf8');
  let keep = Math.max(0, maxBytes - MARKER_RESERVE);

  for (let pass = 0; pass < 4; pass++) {
    const kept = decodePrefix(buf, keep);
    const keptBytes = Buffer.byteLength(kept, 'utf8');
    const tail = marker(size - keptBytes);
    const total = keptBytes + Buffer.byteLength(tail, 'utf8');

    if (total <= maxBytes) return kept + tail;

    keep -= total - maxBytes;
    if (keep < 0) break;
  }

  // Budget too small to hold content plus a marker — drop the marker rather
  // than the guarantee.
  return decodePrefix(buf, maxBytes);
}

/** Collapse whitespace so a multi-line blob fits on one phone line budget. */
export function singleLine(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate a block of assistant prose.
 *
 * Keeps paragraph structure — collapsing newlines in chat text would run code
 * blocks and lists together in a way that reads badly on a phone.
 */
export function clipProse(input: string, maxBytes: number = BUDGETS.assistantText): string {
  return truncateText(input, maxBytes);
}

/** Truncate a unified diff, preferring to keep the head of the change. */
export function clipPatch(patch: string, maxBytes: number = BUDGETS.patch): string {
  return truncateText(patch, maxBytes);
}

/** Truncate a single-line field (path, model, type). */
export function clipShort(input: string, maxBytes: number = BUDGETS.short): string {
  return truncateText(singleLine(input), maxBytes);
}

/**
 * Hard ceiling for a serialized event.
 *
 * The chunk writer asserts against this: a bug that lets a huge field through
 * would otherwise be discovered only when the repo bloats.
 */
export const MAX_EVENT_BYTES = 20_000;

export function serializedSize(event: unknown): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
