/**
 * Byte-level line framing for a file being appended to by another process.
 *
 * The critical property: we buffer **bytes** and only decode when a line is
 * known to be complete. A read can land in the middle of a UTF-8 sequence —
 * routine with CJK text, where a character is three bytes — and decoding that
 * partial tail would emit U+FFFD and, worse, tempt a caller into advancing the
 * persisted offset past bytes it never really consumed.
 *
 * Complete lines end at 0x0A, which cannot occur inside a multi-byte sequence,
 * so a slice ending at a newline is always a valid decode boundary.
 */

export interface FramerOptions {
  /**
   * Bound on a single buffered line. Transcripts contain enormous single lines
   * (system-prompt attachments reach 239 KB); without this, one runaway line
   * would grow the buffer without limit. Exceeding it discards the line and
   * resynchronises at the next newline.
   */
  maxLineBytes?: number;
}

export interface FramerStats {
  lines: number;
  droppedLines: number;
  droppedBytes: number;
  bytes: number;
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const NUL = 0x00;
const SPACE = 0x20;
const TAB = 0x09;

export class LineFramer {
  #buf: Buffer = Buffer.alloc(0);
  #skipping = false;
  readonly #maxLineBytes: number;
  #stats: FramerStats = { lines: 0, droppedLines: 0, droppedBytes: 0, bytes: 0 };

  constructor(options: FramerOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  /**
   * Add bytes and return whatever complete lines they produced.
   *
   * Returns decoded strings with the terminator removed. Empty and
   * whitespace-only lines are skipped, as are leading NUL bytes — the harness
   * itself tolerates NUL-prefixed records, so they appear in real files.
   */
  push(chunk: Buffer): string[] {
    if (chunk.length === 0) return [];

    this.#stats.bytes += chunk.length;
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);

    const lines: string[] = [];
    let start = 0;

    for (;;) {
      const nl = this.#buf.indexOf(NEWLINE, start);
      if (nl === -1) break;

      const raw = this.#buf.subarray(start, nl);
      start = nl + 1;

      if (this.#skipping) {
        // Tail of a line we already decided to discard.
        this.#skipping = false;
        continue;
      }

      const line = this.#clean(raw);
      if (line !== null) lines.push(line);
    }

    // Keep only the unconsumed remainder.
    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);

    if (this.#buf.length > this.#maxLineBytes) {
      this.#stats.droppedLines += 1;
      this.#stats.droppedBytes += this.#buf.length;
      this.#buf = Buffer.alloc(0);
      this.#skipping = true;
    }

    this.#stats.lines += lines.length;
    return lines;
  }

  /**
   * Decode a complete line, or null when it carries nothing worth parsing.
   *
   * Leading NULs are stripped rather than treated as an error: the harness skips
   * them too, so a line that starts with them is still valid JSON.
   */
  #clean(raw: Buffer): string | null {
    let s = 0;
    while (s < raw.length && raw[s] === NUL) s++;
    let e = raw.length;
    if (e > s && raw[e - 1] === CARRIAGE_RETURN) e--;
    if (e <= s) return null;

    // A whitespace-only line cannot be JSON, so hand it back as nothing rather
    // than making the parser fail on it.
    let allBlank = true;
    for (let i = s; i < e; i++) {
      const b = raw[i]!;
      if (b !== SPACE && b !== TAB) {
        allBlank = false;
        break;
      }
    }
    if (allBlank) return null;

    return raw.subarray(s, e).toString('utf8');
  }

  /** True when a partial line is buffered awaiting its newline. */
  get hasPartial(): boolean {
    return this.#buf.length > 0;
  }

  /** Bytes buffered for the incomplete trailing line. */
  get pendingBytes(): number {
    return this.#buf.length;
  }

  /**
   * Best-effort decode of the partial trailing line, for a live "typing" preview.
   *
   * Trailing bytes that do not form a complete character are dropped rather than
   * rendered as U+FFFD, so the caller never shows a replacement glyph for a
   * character that is merely still in flight.
   */
  pendingPreview(maxBytes = 200): string {
    if (this.#buf.length === 0) return '';
    const slice = this.#buf.subarray(Math.max(0, this.#buf.length - maxBytes));

    // Trim a partial character at the *start* of the window: a slice beginning
    // with continuation bytes would otherwise decode as replacement glyphs.
    let from = 0;
    while (from < slice.length && (slice[from]! & 0xc0) === 0x80) from++;

    // Trim a partial character at the *end*: walk back to the last lead byte and
    // drop it if the bytes that follow do not complete the character.
    let end = slice.length;
    let lead = end - 1;
    while (lead >= from && (slice[lead]! & 0xc0) === 0x80) lead--;

    if (lead >= from) {
      const byte = slice[lead]!;
      const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (end - lead < expected) end = lead;
    }

    return end > from ? slice.subarray(from, end).toString('utf8') : '';
  }

  /**
   * Discard buffered bytes and resume fresh.
   *
   * Used when the underlying file is detected as truncated or rotated — the
   * leftover bytes belong to a file that no longer exists.
   */
  reset(): void {
    this.#buf = Buffer.alloc(0);
    this.#skipping = false;
  }

  get stats(): Readonly<FramerStats> {
    return this.#stats;
  }
}
