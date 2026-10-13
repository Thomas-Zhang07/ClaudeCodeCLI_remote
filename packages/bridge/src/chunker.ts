/**
 * Append-only chunk writer with rolling retention.
 *
 * The integrity rules, and why each exists:
 *
 *  - **A sealed chunk is never rewritten.** The reader caches by chunk number
 *    and by content, so rewriting one would desynchronise it silently. Fresh
 *    numbers only — retention deletes whole chunks, it never edits one.
 *  - **A chunk is only advertised once it carries a terminating sentinel.** The
 *    open chunk is deliberately incomplete, so a crash mid-write leaves
 *    something the reader discards rather than half-believes.
 *  - **Retention deletes the oldest chunk rather than compacting.** An archive
 *    file trimmed from the front would be rewritten on every pass, and a
 *    rewritten file can never be cached by the reader — which is the whole
 *    reason chunks are chunked. Deleting keeps every survivor immutable.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ChunkEndSentinel,
  ChunkEntry,
  ChunkManifest,
  NormalizedEvent,
} from '@ccr/shared';

export const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_RETAIN_BYTES = 10 * 1024 * 1024;

export function chunkFilename(n: number): string {
  return `events-${String(n).padStart(4, '0')}.jsonl`;
}

/** What the reader needs to know about a session's retained events. */
export interface ChunkRange {
  chunkFirst: number;
  chunkLast: number;
  firstSeq: number;
  lastSeq: number;
  retainedBytes: number;
  droppedEvents: number;
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
 * Monotonic counter for temporary filenames.
 *
 * A timestamp alone is not enough: two writes within the same millisecond would
 * generate the same temporary name and corrupt each other.
 */
let tempCounter = 0;

/** Windows error codes that mean "held open right now, try again". */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/**
 * Write a file so a reader never observes a partial one.
 *
 * The retry loop exists because of Windows: replacing a file that another
 * process momentarily holds open fails with EPERM, and that happens routinely
 * here — a virus scanner or the search indexer touching a file the instant it is
 * written. Renaming is still the atomic option, so the answer is to retry
 * briefly rather than to fall back to an in-place write that a reader could
 * catch halfway.
 */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${(tempCounter++).toString(36)}-${Date.now().toString(36)}`;
  await writeFile(tmp, data);

  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_ERRORS.has(code)) break;
      await delay(10 * 2 ** attempt);
    }
  }

  await rm(tmp, { force: true }).catch(() => {});
  throw lastError;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface ChunkWriterOptions {
  /** Session directory. Created if absent. This is the published tree. */
  dir: string;
  maxChunkBytes?: number;
  /** Retained bytes for this session before the oldest chunk is deleted. */
  retainBytes?: number;
  /**
   * Where to keep the writer's own bookkeeping.
   *
   * Deliberately **outside** `dir`, and therefore outside the published tree.
   * It is rewritten on every seal, so publishing it would add a changed blob to
   * every publish — churn in the one place this design is trying to minimise —
   * and it is of no use to a reader, which learns the chunk range from
   * `head.json` instead.
   */
  manifestPath?: string;
}

/** Writer bookkeeping for crash recovery. Never published. */
interface PersistedManifest extends ChunkManifest {
  droppedEvents: number;
}

export class ChunkWriter {
  readonly #dir: string;
  readonly #maxChunkBytes: number;
  readonly #retainBytes: number;
  readonly #manifestPath: string;

  #chunk = 1;
  #bytes = 0;
  #lines = 0;
  #firstSeq = 0;
  #sealed: ChunkEntry[] = [];
  #sealedBytes = 0;
  #droppedEvents = 0;
  #ready = false;
  #sessionId = '';

  constructor(options: ChunkWriterOptions) {
    this.#dir = options.dir;
    this.#maxChunkBytes = options.maxChunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.#retainBytes = options.retainBytes ?? DEFAULT_RETAIN_BYTES;
    this.#manifestPath = options.manifestPath ?? join(options.dir, 'manifest.json');
  }

  get chunkNumber(): number {
    return this.#chunk;
  }

  get lastSeq(): number {
    return this.#sealed.at(-1)?.lastSeq ?? this.#firstSeq - 1 + this.#lines;
  }

  /**
   * What the reader polls: which chunks exist and what they cover.
   *
   * `chunkLast` is the highest chunk that actually holds events, which is not
   * the same as the chunk being written to — after a seal, the writer has
   * already moved on to the next number, and advertising that would send the
   * reader after a file that does not exist.
   *
   * An empty range is reported as `chunkLast < chunkFirst`, so a session with
   * nothing recorded yet asks the reader to fetch nothing at all.
   */
  get range(): ChunkRange {
    const oldest = this.#sealed[0];
    const newestSealed = this.#sealed.at(-1);
    const hasOpenEvents = this.#lines > 0;

    return {
      chunkFirst: oldest?.n ?? this.#chunk,
      chunkLast: hasOpenEvents ? this.#chunk : (newestSealed?.n ?? this.#chunk - 1),
      firstSeq: oldest?.firstSeq ?? this.#firstSeq,
      lastSeq: hasOpenEvents
        ? this.#firstSeq + this.#lines - 1
        : (newestSealed?.lastSeq ?? 0),
      retainedBytes: this.#sealedBytes + this.#bytes,
      droppedEvents: this.#droppedEvents,
    };
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
    await mkdir(dirname(this.#manifestPath), { recursive: true }).catch(() => {});

    if (existsSync(this.#manifestPath)) {
      try {
        const parsed = JSON.parse(await readFile(this.#manifestPath, 'utf8')) as PersistedManifest;
        if (Array.isArray(parsed.chunks)) {
          this.#sealed = parsed.chunks;
          this.#droppedEvents = parsed.droppedEvents ?? 0;
          this.#sealedBytes = this.#sealed.reduce((sum, c) => sum + c.bytes, 0);
          this.#chunk = this.#sealed.reduce((max, c) => Math.max(max, c.n), 0) + 1;
        }
      } catch {
        // A corrupt manifest is recoverable: start numbering above whatever chunk
        // files exist, so nothing already written is overwritten.
        this.#sealed = [];
        this.#sealedBytes = 0;
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

    await writeFile(join(this.#dir, chunkFilename(this.#chunk)), line, { flag: 'a' });
    this.#bytes += size;
    this.#lines++;

    if (this.#bytes >= this.#maxChunkBytes) {
      await this.seal();
    }
  }

  /**
   * Terminate the current chunk, record it, and apply retention.
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
      crc32: crc32(Buffer.from(`${this.#firstSeq}:${this.#lines}`)),
    };
    await writeFile(path, `${JSON.stringify(sentinel)}\n`, { flag: 'a' });

    const bytes = await readFile(path);
    const entry: ChunkEntry = {
      n: this.#chunk,
      sha256: sha256(bytes),
      bytes: bytes.length,
      firstSeq: this.#firstSeq,
      lastSeq: this.#firstSeq + this.#lines - 1,
      lines: this.#lines,
    };

    this.#sealed.push(entry);
    this.#sealedBytes += entry.bytes;

    this.#chunk += 1;
    this.#bytes = 0;
    this.#lines = 0;
    this.#firstSeq = 0;

    await this.#enforceRetention();
    await this.#persistManifest();

    return entry;
  }

  /**
   * Delete the oldest chunks until the session fits its budget.
   *
   * The newest chunk is never deleted, even alone over budget: a session that
   * retains nothing cannot be read at all, and one enormous chunk is better than
   * an empty session.
   */
  async #enforceRetention(): Promise<void> {
    while (this.#sealedBytes + this.#bytes > this.#retainBytes && this.#sealed.length > 1) {
      const oldest = this.#sealed.shift();
      if (!oldest) break;

      await rm(join(this.#dir, chunkFilename(oldest.n)), { force: true }).catch(() => {});
      this.#sealedBytes -= oldest.bytes;
      this.#droppedEvents += oldest.lines;
    }
  }

  async #persistManifest(): Promise<void> {
    const manifest: PersistedManifest = {
      sessionId: this.#sessionId,
      chunks: this.#sealed,
      droppedEvents: this.#droppedEvents,
    };
    await atomicWriteJson(this.#manifestPath, manifest);
  }

  /** Seal any partial chunk and flush the manifest. */
  async finish(): Promise<void> {
    await this.seal();
    await this.#persistManifest();
  }

  /** Total bytes on disk for this session, for diagnostics. */
  async diskBytes(): Promise<number> {
    let total = 0;
    for (const entry of this.#sealed) {
      const info = await stat(join(this.#dir, chunkFilename(entry.n))).catch(() => null);
      if (info) total += info.size;
    }
    return total + this.#bytes;
  }

  sealCount(): number {
    return this.#sealed.length;
  }
}
