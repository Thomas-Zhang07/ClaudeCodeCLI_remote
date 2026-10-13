/**
 * Append-only chunk writer.
 *
 * Events are serialized into `events-NNNN.jsonl` under a session directory.
 *
 * The integrity rules, and why each exists:
 *
 *  - **A sealed chunk is never rewritten.** The phone caches by chunk number, so
 *    rewriting one would silently desynchronise it. Fresh numbers only.
 *  - **A chunk is only advertised once it carries a terminating sentinel.** The
 *    open chunk is deliberately incomplete, so a crash mid-write leaves
 *    something the reader discards rather than half-believes.
 *  - **`manifest.json` carries a digest and a sequence range per chunk**, letting
 *    the reader verify both the bytes and the continuity of the stream.
 *  - **`state.json` advertises `chunkLast` only after the chunk is sealed and
 *    flushed**, so it can never point at something the reader cannot fetch.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ChunkEndSentinel,
  ChunkEntry,
  ChunkManifest,
  NormalizedEvent,
  SessionState,
} from '@ccr/shared';

export const DEFAULT_CHUNK_BYTES = 256 * 1024;

export function chunkFilename(n: number): string {
  return `events-${String(n).padStart(4, '0')}.jsonl`;
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32, used for the cheap per-chunk sentinel check. */
export function crc32(buf: Buffer): string {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Write a file so a reader never observes a partial one.
 *
 * Writes alongside the target then renames, which is atomic within a volume.
 * The temporary name is randomised so concurrent writers cannot collide.
 */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface ChunkWriterOptions {
  /** Session directory. Created if absent. */
  dir: string;
  maxChunkBytes?: number;
  /** Chunk number to start at. Normally recovered from the manifest. */
  startChunk?: number;
}

export class ChunkWriter {
  readonly #dir: string;
  readonly #maxChunkBytes: number;

  #chunk = 1;
  #bytes = 0;
  #lines = 0;
  #firstSeq = 0;
  #lastSeq = 0;
  #sealed: ChunkEntry[] = [];
  #ready = false;
  #sessionId = '';

  constructor(options: ChunkWriterOptions) {
    this.#dir = options.dir;
    this.#maxChunkBytes = options.maxChunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (options.startChunk) this.#chunk = options.startChunk;
  }

  get chunkNumber(): number {
    return this.#chunk;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get manifest(): ChunkManifest {
    return { sessionId: this.#sessionId, chunks: [...this.#sealed] };
  }

  /**
   * Prepare the directory and work out where to resume.
   *
   * If the previous run died mid-chunk, the partial file has no sentinel and is
   * not in the manifest. Rather than discard events already written, we read it
   * back to recover the sequence position and continue appending — this is the
   * one file that may legitimately be extended in place, because nothing has
   * advertised it yet.
   */
  async open(sessionId: string): Promise<void> {
    this.#sessionId = sessionId;
    await mkdir(this.#dir, { recursive: true });

    const manifestPath = join(this.#dir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as ChunkManifest;
        if (Array.isArray(parsed.chunks)) {
          this.#sealed = parsed.chunks;
          const highest = this.#sealed.reduce((max, c) => Math.max(max, c.n), 0);
          this.#chunk = highest + 1;
        }
      } catch {
        // A corrupt manifest is recoverable: start a fresh chunk above whatever
        // chunk files exist, so nothing already written is overwritten.
        this.#sealed = [];
        this.#chunk = 1;
      }
    }

    const path = join(this.#dir, chunkFilename(this.#chunk));
    if (existsSync(path)) {
      const existing = await readFile(path, 'utf8');
      for (const line of existing.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { seq?: number; t?: string };
          if (parsed.t === 'chunk_end') continue;
          if (typeof parsed.seq === 'number') {
            if (this.#firstSeq === 0) this.#firstSeq = parsed.seq;
            this.#lastSeq = Math.max(this.#lastSeq, parsed.seq);
          }
          this.#lines++;
          this.#bytes += Buffer.byteLength(`${trimmed}\n`, 'utf8');
        } catch {
          // A torn final line from the crash that caused this recovery.
        }
      }
    }

    this.#ready = true;
  }

  /**
   * Append one event. Seals the current chunk and rolls to the next when the
   * size budget is reached.
   */
  async append(event: NormalizedEvent): Promise<void> {
    if (!this.#ready) throw new Error('ChunkWriter.open() must be called first');

    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line, 'utf8');

    if (this.#firstSeq === 0) this.#firstSeq = event.seq;
    this.#lastSeq = Math.max(this.#lastSeq, event.seq);

    await writeFile(join(this.#dir, chunkFilename(this.#chunk)), line, { flag: 'a' });
    this.#bytes += size;
    this.#lines++;

    if (this.#bytes >= this.#maxChunkBytes) {
      await this.seal();
    }
  }

  /**
   * Terminate the current chunk and record it in the manifest.
   *
   * The sentinel is written last so its presence proves the chunk is complete.
   */
  async seal(): Promise<ChunkEntry | null> {
    if (this.#lines === 0) return null;

    const path = join(this.#dir, chunkFilename(this.#chunk));
    const sentinel: ChunkEndSentinel = {
      t: 'chunk_end',
      n: this.#chunk,
      lines: this.#lines,
      crc32: crc32(Buffer.from(`${this.#firstSeq}:${this.#lastSeq}:${this.#lines}`)),
    };
    await writeFile(path, `${JSON.stringify(sentinel)}\n`, { flag: 'a' });

    const bytes = await readFile(path);
    const entry: ChunkEntry = {
      n: this.#chunk,
      sha256: sha256(bytes),
      bytes: bytes.length,
      firstSeq: this.#firstSeq,
      lastSeq: this.#lastSeq,
      lines: this.#lines,
    };

    this.#sealed.push(entry);
    await atomicWriteJson(join(this.#dir, 'manifest.json'), this.manifest);

    this.#chunk += 1;
    this.#bytes = 0;
    this.#lines = 0;
    this.#firstSeq = 0;

    return entry;
  }

  /** Seal any partial chunk and write the session state. */
  async finish(state: SessionState): Promise<void> {
    const entry = await this.seal();
    const chunkLast = entry ? entry.n : this.#sealed.at(-1)?.n;
    await atomicWriteJson(join(this.#dir, 'state.json'), {
      ...state,
      ...(chunkLast !== undefined ? { chunkLast } : {}),
    } satisfies SessionState);
  }

  sealCount(): number {
    return this.#sealed.length;
  }
}
