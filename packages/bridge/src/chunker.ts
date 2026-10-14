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
 *  - **The advertised range is contiguous and parseable end to end.** The reader
 *    walks `chunkFirst..chunkLast` in order and stops at the first chunk it
 *    cannot parse, so a hole inside the range hides every chunk above it —
 *    including the newest ones. Where the range comes from the files rather than
 *    the manifest (`#recoverSealed`), it therefore begins after the last chunk
 *    that could not be vouched for rather than spanning it.
 *  - **Retention deletes the oldest chunk rather than compacting.** An archive
 *    file trimmed from the front would be rewritten on every pass, and a
 *    rewritten file can never be cached by the reader — which is the whole
 *    reason chunks are chunked. Deleting keeps every survivor immutable.
 *  - **A chunk number only means something within a generation.** Immutability
 *    holds for as long as a series lives, but the series itself can be rebuilt:
 *    clearing the output directory restarts the numbering, so
 *    `events-0001.jsonl` can go from 398 events to 49 under the same name. The
 *    reader caches by path, so it kept serving the old bytes and reported a
 *    stream gap that did not exist. Every session therefore carries an opaque
 *    {@link generation} that changes when — and only when — the series is
 *    rebuilt, and the reader keys its cache by it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MAX_EVENT_BYTES, isTranscriptEvent } from '@ccr/shared';
import type {
  ChunkEndSentinel,
  ChunkEntry,
  ChunkManifest,
  EventKind,
  NormalizedEvent,
} from '@ccr/shared';

export const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_RETAIN_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_CHUNKS = 300;

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
  /** Identifies the run of chunks these numbers belong to. See the file header. */
  generation: string;
}

/**
 * A new series token.
 *
 * Deliberately short — 8 random bytes, hex — because it travels in `head.json`,
 * which is polled every few seconds. It is not ordered and carries no meaning:
 * the only property that matters is that it differs from the last one.
 */
function mintGeneration(): string {
  return randomBytes(8).toString('hex');
}

function validGeneration(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
   * Retained chunk count for this session.
   *
   * A second bound because a chunk is sealed at every publish, so a session of
   * small turns produces many small chunks and would hit a large file count long
   * before it hit a byte budget.
   */
  maxChunks?: number;
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
  /**
   * The series token, persisted so an ordinary restart continues the same one.
   *
   * Optional because a manifest written before generations existed carries no
   * such field. That is the only case in which this writer cannot recover the
   * token, and it mints a replacement rather than publishing nothing — see
   * `open()`.
   */
  generation?: string;
}

export class ChunkWriter {
  readonly #dir: string;
  readonly #maxChunkBytes: number;
  readonly #retainBytes: number;
  readonly #maxChunks: number;
  readonly #manifestPath: string;

  #chunk = 1;
  #bytes = 0;
  #lines = 0;
  /**
   * Sequence of the first event in the open chunk, or null when it is empty.
   *
   * Null rather than 0, because 0 is a legitimate sequence: a session's first
   * event is seq 0. Using 0 as the "unset" marker made the first event's
   * sequence invisible, so the sentinel was signed over the *second* event's
   * sequence instead. The reader derives the checksum from the chunk's actual
   * first event, so every affected chunk failed validation and was rejected
   * whole — the reader showed nothing at all.
   */
  #firstSeq: number | null = null;
  #sealed: ChunkEntry[] = [];
  #sealedBytes = 0;
  #droppedEvents = 0;
  #ready = false;
  #sessionId = '';
  /** Minted or recovered in `open()`; empty only before it is called. */
  #generation = '';

  constructor(options: ChunkWriterOptions) {
    this.#dir = options.dir;
    this.#maxChunkBytes = options.maxChunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.#retainBytes = options.retainBytes ?? DEFAULT_RETAIN_BYTES;
    this.#maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.#manifestPath = options.manifestPath ?? join(options.dir, 'manifest.json');
  }

  get chunkNumber(): number {
    return this.#chunk;
  }

  /** This series' token. Stable until the chunk series is rebuilt. */
  get generation(): string {
    return this.#generation;
  }

  get lastSeq(): number {
    if (this.#lines === 0 || this.#firstSeq === null) {
      return this.#sealed.at(-1)?.lastSeq ?? -1;
    }
    return this.#firstSeq + this.#lines - 1;
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
      firstSeq: oldest?.firstSeq ?? this.#firstSeq ?? 0,
      lastSeq: hasOpenEvents
        ? (this.#firstSeq ?? 0) + this.#lines - 1
        : (newestSealed?.lastSeq ?? 0),
      retainedBytes: this.#sealedBytes + this.#bytes,
      droppedEvents: this.#droppedEvents,
      generation: this.#generation,
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
   *
   * This is also where the series token is decided, and the rule is the one
   * thing to get right: **the token changes when the chunk series is rebuilt and
   * at no other time.** Changing it discards every reader's cache of this
   * session, so a spurious change is a cost paid by every phone; failing to
   * change it on a rebuild is the stale-cache bug the token exists to prevent.
   * The chunk files themselves therefore decide, not the manifest: the manifest
   * lives outside the published tree and can outlive the output it describes.
   */
  async open(sessionId: string): Promise<void> {
    this.#sessionId = sessionId;
    await mkdir(this.#dir, { recursive: true });
    await mkdir(dirname(this.#manifestPath), { recursive: true }).catch(() => {});

    const onDisk = await this.#highestChunkOnDisk();

    if (onDisk === 0) {
      // A fresh session directory — rebuilt, cold-started, or never written to.
      // Whatever the manifest still claims describes chunks that no longer
      // exist, so its token must not be kept: restarting at chunk 1 under the
      // old one is exactly the stale-cache hazard, since the reader is entitled
      // to believe `events-0001.jsonl` never changes.
      this.#sealed = [];
      this.#sealedBytes = 0;
      this.#droppedEvents = 0;
      this.#chunk = 1;
      this.#generation = mintGeneration();
    } else if (existsSync(this.#manifestPath)) {
      let parsed: PersistedManifest | null = null;
      try {
        parsed = JSON.parse(await readFile(this.#manifestPath, 'utf8')) as PersistedManifest;
      } catch {
        parsed = null;
      }

      if (parsed !== null && Array.isArray(parsed.chunks)) {
        this.#sealed = parsed.chunks;
        this.#droppedEvents = parsed.droppedEvents ?? 0;
        this.#sealedBytes = this.#sealed.reduce((sum, c) => sum + c.bytes, 0);
        this.#chunk = this.#sealed.reduce((max, c) => Math.max(max, c.n), 0) + 1;
        // The series continues, so the token must not move. A manifest written
        // before generations existed cannot name one, so a fresh token is minted
        // here: one invalidation on upgrade, after which the session is
        // protected. Leaving it blank instead would keep every reader on the
        // unguarded path for as long as the series lives.
        this.#generation = validGeneration(parsed.generation) ?? mintGeneration();
      } else {
        // A corrupt manifest is recoverable, and only partly from the manifest
        // itself: start numbering above whatever chunk files exist, so nothing
        // already written is overwritten.
        //
        // Above the *files*, not at 1. Resetting to 1 re-enters the chunk the
        // previous run was writing, so sealed history the phone has already
        // cached is rewritten in place under the same number — which the reader
        // has no way to notice, because immutability is the property it is
        // entitled to assume.
        //
        // Above the files rather than above the *sealed* files, which is the
        // distinction that matters if the highest file is one that cannot be
        // vouched for: its number is skipped rather than re-entered. A chunk
        // whose sentinel is missing is one the previous run was still writing,
        // and the manifest that would say how many events it had already taken
        // is the very thing that is unreadable — so it is left alone and the
        // series continues past it. Nothing already written is touched, which is
        // the whole of what this rule is for.
        //
        // The sealed list itself is not lost with the manifest — the chunk files
        // carry their own proof of completeness — so it is rebuilt from them
        // rather than left empty. Empty is what made this recovery expensive:
        // `chunkFirst` moved above every chunk still on disk, so the reader was
        // never told to assemble them with the new events and retention could no
        // longer see them to prune them. See `#recoverSealed`.
        //
        // The old token is unrecoverable here, so a new one is minted. That
        // discards cached copies of chunks which did not change — waste, but
        // never wrong, and the alternative is a reader trusting a token whose
        // meaning this writer can no longer vouch for.
        this.#sealed = await this.#recoverSealed(onDisk);
        this.#sealedBytes = this.#sealed.reduce((sum, c) => sum + c.bytes, 0);
        this.#chunk = onDisk + 1;
        // The one number the files cannot give back: `droppedEvents` counted the
        // events retention had deleted, and only the manifest ever recorded it.
        // Reporting 0 would be a claim of completeness that the files on disk
        // already refute — retention cuts from the front only, so a series that
        // no longer starts at chunk 1 has certainly lost events — and the phone
        // reads "0" as "nothing was pruned" and drops its explanation for a
        // record that begins partway through (Chat.vue only prints the note
        // above zero). So report what is provable instead of what is unknown:
        // every chunk number below the write position was used by a chunk
        // holding at least one event, because an empty chunk is never sealed, so
        // the numbers the recovered series does not account for bound the loss
        // from below. A true lower bound is a smaller number than the truth, but
        // it keeps the fact of the pruning — the part the reader acts on — and
        // never asserts a figure the bridge cannot support.
        this.#droppedEvents = this.#chunk - 1 - this.#sealed.length;
        this.#generation = mintGeneration();
      }
    } else {
      // Chunks on disk with no manifest at all: the one state that means a
      // crash before the first seal, because a seal is what persists the
      // manifest. The open chunk below is recovered and continued, and nothing
      // has advertised it, so there is no token to recover either — and none to
      // strand a reader with. Minting one here cannot discard anything a reader
      // could be holding.
      this.#generation = mintGeneration();
    }

    const path = join(this.#dir, chunkFilename(this.#chunk));
    if (existsSync(path)) {
      const existing = await readFile(path, 'utf8');

      // Cut a torn final line off before resuming.
      //
      // The recovery below deliberately continues an unterminated chunk rather
      // than discarding its events — but `append` opens with `'a'`, so leaving a
      // fragment in place welds the next JSON object onto it: `{"kind":"assist`
      // becomes `{"kind":"assist{"seq":4,…}`. That line never parses again, and
      // because the sentinel covers the whole chunk the reader rejects all of
      // it — permanently, and including every event written before the crash.
      const lastNewline = existing.lastIndexOf('\n');
      const whole = lastNewline === -1 ? '' : existing.slice(0, lastNewline + 1);
      if (whole.length !== existing.length) {
        await truncate(path, Buffer.byteLength(whole, 'utf8'));
      }

      for (const line of whole.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as { seq?: number; t?: string };
          if (parsed.t === 'chunk_end') continue;
          if (typeof parsed.seq === 'number') {
            // The first event recovered from a partial chunk, so sequence 0
            // counts — only null means "nothing seen yet".
            if (this.#firstSeq === null) this.#firstSeq = parsed.seq;
          }
          this.#lines++;
          this.#bytes += Buffer.byteLength(`${trimmed}\n`, 'utf8');
        } catch {
          // A torn line in the middle, which only a partial truncate leaves.
        }
      }
    }

    this.#ready = true;
  }

  /** Highest chunk number with a file on disk, or 0 when there is none. */
  async #highestChunkOnDisk(): Promise<number> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    let highest = 0;
    for (const name of names) {
      const match = /^events-(\d+)\.jsonl$/.exec(name);
      if (match) highest = Math.max(highest, Number.parseInt(match[1]!, 10));
    }
    return highest;
  }

  /**
   * Rebuild the sealed list from the chunk files, for when the manifest cannot
   * be read.
   *
   * A chunk file carries its own proof of completeness — the terminating
   * sentinel, written last, naming the chunk and the line count and signed over
   * the sequence the chunk starts at — so a scan can recover everything the
   * manifest held except the dropped count. A file that cannot produce that
   * proof is one the *reader* would refuse as well, and the writer must not
   * advertise what the reader cannot parse.
   *
   * Only the contiguous run ending at the highest chunk file is taken: the walk
   * goes down from the top and stops at the first number that cannot be vouched
   * for, whether that is a file that fails its sentinel or one that is missing
   * altogether. This is the reader's own constraint, not a preference — the
   * phone fetches `chunkFirst..chunkLast` in order and breaks at the first chunk
   * it cannot parse (`relay.ts`, `parseChunk`), so a hole anywhere inside the
   * advertised range would hide every chunk above it, including the ones this
   * writer is about to add. A range that started below the break would therefore
   * produce exactly the outage the rebuild is meant to end.
   *
   * The cost of that rule is real and is the reason it needs stating: when the
   * highest file is the untrustworthy one — the crash mid-chunk case — the run
   * above the break is empty, so nothing is advertised at all until new events
   * arrive. A shorter range is the honest answer there, because the files below
   * the break cannot be reached through the range without the reader stopping on
   * the break first; leaving them out of the series also means leaving them out
   * of retention, which is why the abandoned files stay on disk untouched
   * (deleting them is not this writer's call, and they are the only copy of
   * whatever they hold).
   */
  async #recoverSealed(highest: number): Promise<ChunkEntry[]> {
    const recovered: ChunkEntry[] = [];
    for (let n = highest; n >= 1; n--) {
      const entry = await this.#sealedChunk(n);
      if (entry === null) break;
      recovered.unshift(entry);
    }
    return recovered;
  }

  /**
   * The manifest entry for chunk `n`, or null when the file cannot be vouched
   * for.
   *
   * The test is deliberately the one the reader applies, because a chunk this
   * accepts and the reader rejects is a chunk advertised and then refused: the
   * sentinel must be present, must name this chunk's number, and must agree with
   * the file's own contents. The line count is checked as well as the checksum
   * because `lines === events.length` is the stronger of the two — the checksum
   * is derived from the same count, so it cannot catch a chunk whose events were
   * replaced wholesale, and it covers truncation rather than corruption (see the
   * note on the sentinel's CRC in the docs).
   */
  async #sealedChunk(n: number): Promise<ChunkEntry | null> {
    const path = join(this.#dir, chunkFilename(n));

    let raw: Buffer;
    let size: number;
    try {
      // Size from `stat` rather than `raw.length` so the recorded byte count is
      // the file's size on disk — the number retention budgets against and the
      // reader is told it is fetching — not merely what this read happened to
      // see.
      raw = await readFile(path);
      size = (await stat(path)).size;
    } catch {
      return null; // Unreadable, or gone: either way nothing here to advertise.
    }

    const lines = raw.toString('utf8').split('\n');
    let last = lines.length - 1;
    while (last >= 0 && lines[last]!.trim() === '') last--;
    if (last < 0) return null; // Empty: a chunk nothing has been written to yet.

    let sentinel: ChunkEndSentinel;
    try {
      const parsed = JSON.parse(lines[last]!.trim()) as Partial<ChunkEndSentinel>;
      if (
        parsed.t !== 'chunk_end' ||
        typeof parsed.n !== 'number' ||
        typeof parsed.lines !== 'number' ||
        typeof parsed.crc32 !== 'string'
      ) {
        return null;
      }
      sentinel = parsed as ChunkEndSentinel;
    } catch {
      // No sentinel at all: the chunk was still open when the process died, or
      // its last line is torn. Unsealed is not corruption — it is the state the
      // header calls deliberately incomplete — but it is not an entry either.
      return null;
    }

    // The filename is the only place the number is recorded independently of the
    // file's contents, so it is what proves this is the chunk it claims to be
    // rather than a copy of another one under a different name.
    if (sentinel.n !== n) return null;

    let firstSeq: number | null = null;
    let events = 0;
    for (let i = 0; i < last; i++) {
      const text = lines[i]!.trim();
      if (text === '') continue;

      let parsed: { seq?: unknown };
      try {
        parsed = JSON.parse(text) as { seq?: unknown };
      } catch {
        return null; // A line that does not parse is one the reader cannot use.
      }
      // No `t` check: only the sentinel is ever written without a sequence, so a
      // non-numeric `seq` means the line is not an event.
      if (typeof parsed.seq !== 'number') return null;
      if (firstSeq === null) firstSeq = parsed.seq;
      events++;
    }

    // A sealed chunk always holds at least one event — `seal()` refuses an empty
    // one — so a sentinel over no events is not a chunk this writer wrote.
    if (firstSeq === null) return null;
    if (events !== sentinel.lines) return null;
    if (sentinel.crc32 !== crc32(Buffer.from(`${firstSeq}:${sentinel.lines}`))) return null;

    return {
      n,
      sha256: sha256(raw),
      bytes: size,
      firstSeq,
      lastSeq: firstSeq + sentinel.lines - 1,
      lines: sentinel.lines,
    };
  }

  /**
   * Append one event. Seals the current chunk and rolls to the next when the
   * size budget is reached.
   */
  async append(event: NormalizedEvent): Promise<void> {
    if (!this.#ready) throw new Error('ChunkWriter.open() must be called first');

    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line, 'utf8');

    // The ceiling every event must meet, checked here because this is the one
    // place all of them pass through and the last before they are published.
    // Checked before any state moves, so a rejection leaves the chunk exactly as
    // it was rather than half-advanced.
    if (size > MAX_EVENT_BYTES) {
      throw new Error(
        `event ${event.kind} (seq ${event.seq}) serializes to ${size} bytes, over MAX_EVENT_BYTES (${MAX_EVENT_BYTES})`,
      );
    }

    if (this.#firstSeq === null) this.#firstSeq = event.seq;

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
    if (this.#lines === 0 || this.#firstSeq === null) return null;

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
    // Back to "empty", not to 0 — the next chunk's first event may itself be
    // sequence 0 if it is the session's first.
    this.#firstSeq = null;

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
    const overBudget = (): boolean =>
      this.#sealedBytes + this.#bytes > this.#retainBytes ||
      this.#sealed.length > this.#maxChunks;

    while (overBudget() && this.#sealed.length > 1) {
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
      // Persisted for the same reason the chunks are: so a restart continues
      // the series rather than silently starting a new one, which would throw
      // away the reader's cache on every bridge restart.
      generation: this.#generation,
    };
    await atomicWriteJson(this.#manifestPath, manifest);
  }

  /** Seal any partial chunk and flush the manifest. */
  async finish(): Promise<void> {
    await this.seal();
    await this.#persistManifest();
  }

  /**
   * The kind of the last main-thread event already written for this session.
   *
   * Read at startup when no persisted value exists, so the injection guard has
   * an answer immediately rather than after the session next happens to emit
   * something. Without this, a bridge restarted while a session is idle reads
   * nothing new — the tailer is already at the end — so the guard sees "unknown"
   * and refuses every prompt indefinitely.
   *
   * Scans the newest chunk first, falling back to earlier ones, because a chunk
   * containing only subagent events has no main-thread event to report.
   */
  async readLastMainKind(): Promise<string | null> {
    const newestFirst = [this.#chunk, ...this.#sealed.map((c) => c.n).reverse()];

    for (const n of newestFirst) {
      const path = join(this.#dir, chunkFilename(n));
      if (!existsSync(path)) continue;

      const lines = (await readFile(path, 'utf8')).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;

        let parsed: { kind?: unknown; agentId?: unknown; t?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue; // A torn final line from an unclean shutdown.
        }
        if (parsed.t === 'chunk_end') continue;
        // Only what the transcript says. Bridge-synthesized events — a title
        // change, an attention note, the record of a prompt's fate — describe
        // this process's bookkeeping, and letting one answer "what did the
        // main thread last do" latched the guard into refusing forever.
        if (
          parsed.agentId === null &&
          typeof parsed.kind === 'string' &&
          isTranscriptEvent(parsed.kind as EventKind)
        ) {
          return parsed.kind;
        }
      }
    }

    return null;
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
