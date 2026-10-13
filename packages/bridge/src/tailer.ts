/**
 * Incremental reader for a transcript file another process is appending to.
 *
 * Three things make this less trivial than `readFile`:
 *
 *  - **Files are large.** Individual transcripts reach tens of megabytes and the
 *    store here is 255 MB, so nothing is ever read whole. We read forward from a
 *    persisted offset in bounded chunks.
 *  - **Writes are partial.** A read can land mid-line and even mid-character.
 *    The framer buffers bytes until a line is complete; the offset only advances
 *    past bytes we actually consumed, so a torn tail is re-read next time rather
 *    than lost or double-counted.
 *  - **The file can be replaced.** A truncated or rotated file leaves our offset
 *    pointing into nothing, which is why the offset is keyed to a file identity
 *    rather than just a path.
 */

import { open, stat } from 'node:fs/promises';

import { LineFramer } from '@ccr/shared';

/** Per-file bookkeeping, persisted between runs. */
export interface TailState {
  path: string;
  /** File identity (inode / file index). Detects replacement, not just growth. */
  identity: string;
  offset: number;
  sizeAtOffset: number;
  mtimeAtOffset: number;
}

export interface TailerOptions {
  /** Bytes to replay when a file is first seen, so a resumed session has context. */
  coldStartBytes: number;
  /** Cap on bytes read per poll, so one catch-up cannot stall the loop. */
  maxReadBytes?: number;
}

const DEFAULT_MAX_READ = 4 * 1024 * 1024;

export class Tailer {
  readonly path: string;
  readonly #framer = new LineFramer();
  readonly #options: Required<TailerOptions>;

  #identity = '';
  #offset = 0;
  #sizeAtOffset = 0;
  #mtimeAtOffset = 0;
  /** True when starting mid-file and the leading fragment must be discarded. */
  #skipPartial = false;
  #missing = false;
  /**
   * Whether we have ever seen this file.
   *
   * Kept explicit rather than inferred from `sizeAtOffset === 0`: a session file
   * is legitimately zero bytes when first created, and conflating that with
   * "never seen" would re-trigger the cold-start seek on the next poll.
   */
  #initialised = false;

  constructor(path: string, options: TailerOptions, state?: TailState) {
    this.path = path;
    this.#options = {
      coldStartBytes: options.coldStartBytes,
      maxReadBytes: options.maxReadBytes ?? DEFAULT_MAX_READ,
    };

    if (state && state.path === path) {
      this.#identity = state.identity;
      this.#offset = state.offset;
      this.#sizeAtOffset = state.sizeAtOffset;
      this.#mtimeAtOffset = state.mtimeAtOffset;
      this.#initialised = true;
    }
  }

  /**
   * Advance the file and return any complete new lines.
   *
   * Returns an empty array when nothing changed, which is the common case — this
   * runs a few times a second per session.
   */
  async poll(): Promise<string[]> {
    const info = await this.#stat();
    if (!info) return [];

    const identity = String(info.ino || 0);

    // A different file at the same path: the old offset means nothing.
    if (this.#identity && identity !== '0' && identity !== this.#identity) {
      this.#framer.reset();
      this.#offset = 0;
      this.#skipPartial = false;
    }
    this.#identity = identity;

    // Truncated or rotated: our offset now points past the end.
    if (info.size < this.#offset) {
      this.#framer.reset();
      this.#offset = 0;
      this.#skipPartial = false;
    }

    // First sight of this file. Replaying all of a 50 MB transcript to catch up
    // would be pointless, so start inside a bounded window and resynchronise at
    // the next newline.
    if (!this.#initialised) {
      this.#initialised = true;
      if (info.size > this.#options.coldStartBytes) {
        this.#offset = info.size - this.#options.coldStartBytes;
        this.#skipPartial = true;
      }
    }

    this.#sizeAtOffset = info.size;
    this.#mtimeAtOffset = info.mtimeMs;

    if (info.size <= this.#offset) return [];

    const lines: string[] = [];
    const target = Math.min(info.size, this.#offset + this.#options.maxReadBytes);

    while (this.#offset < target) {
      const chunk = await this.#read(this.#offset, target);
      if (!chunk || chunk.length === 0) break;

      this.#offset += chunk.length;

      let usable = chunk;
      if (this.#skipPartial) {
        const nl = chunk.indexOf(0x0a);
        if (nl === -1) continue; // still inside the fragment
        usable = chunk.subarray(nl + 1);
        this.#skipPartial = false;
      }

      lines.push(...this.#framer.push(usable));
    }

    return lines;
  }

  /** Bytes read but not yet terminated by a newline. */
  get pendingBytes(): number {
    return this.#framer.pendingBytes;
  }

  /** Best-effort text of the in-flight line, for a live preview. */
  get preview(): string {
    return this.#framer.pendingPreview();
  }

  /** True when the file was absent on the last poll. */
  get missing(): boolean {
    return this.#missing;
  }

  get stats(): LineFramer['stats'] {
    return this.#framer.stats;
  }

  /** Snapshot for persistence. */
  getState(): TailState {
    return {
      path: this.path,
      identity: this.#identity,
      offset: this.#offset,
      sizeAtOffset: this.#sizeAtOffset,
      mtimeAtOffset: this.#mtimeAtOffset,
    };
  }

  async #stat(): Promise<{ size: number; mtimeMs: number; ino: number } | null> {
    try {
      const s = await stat(this.path);
      this.#missing = false;
      return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
    } catch {
      // A session file can vanish when its project is cleaned up. Report it
      // rather than throwing, so one missing file cannot stop the poll loop.
      this.#missing = true;
      return null;
    }
  }

  async #read(start: number, end: number): Promise<Buffer | null> {
    const length = end - start;
    if (length <= 0) return null;

    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return null;
    }

    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return bytesRead === 0 ? null : buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }
}
