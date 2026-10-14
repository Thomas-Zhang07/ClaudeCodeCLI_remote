/**
 * Chunk cache, keyed by repository path plus the session's generation.
 *
 * It now holds only sealed event chunks, and that makes caching simple: a chunk
 * is immutable once written, so a cached chunk is never stale and never needs
 * revalidating. The path is the key — the sha argument exists for callers that
 * do have one (and pass `''` when they do not) — but the path *alone* is not
 * enough. A chunk number only means something within a generation: rebuilding
 * the bridge's output restarts the numbering at chunk 1, so
 * `events-0001.jsonl` can hold different events under the same name, and a
 * reader keyed by path alone served the old bytes and reported a stream gap that
 * did not exist. Keys are therefore `<session dir>/<generation>/events-NNNN.jsonl`,
 * and {@link BlobCache.evictExcept} retires a whole previous generation.
 * Not fetching a chunk we already hold is the whole point of the numbered-chunk
 * layout.
 *
 * Entries are written to localStorage so reopening the PWA paints from the last
 * known state instead of from an empty screen.
 *
 * The cache is best-effort by design: it is bounded, evictable, and every access
 * is guarded, because localStorage throws in private mode and runs out of quota
 * well before a phone's disk does.
 */

import { getJSON } from './storage';

interface CacheEntry {
  sha: string;
  text: string;
  /** Last touch, for eviction ordering. */
  at: number;
}

const KEY = 'ccr.blobcache.v2';
const MAX_BYTES = 3_000_000;
const MAX_ENTRIES = 500;
/**
 * Nothing this large is worth keeping around.
 *
 * The bridge caps a chunk at 256 KiB, so a normal chunk fits comfortably; this
 * bounds the odd oversized one, which is always re-fetchable.
 */
const MAX_ENTRY_CHARS = 400_000;
const WRITE_DEBOUNCE_MS = 900;

function isValidEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e['sha'] === 'string' && typeof e['text'] === 'string' && typeof e['at'] === 'number';
}

export class BlobCache {
  #entries = new Map<string, CacheEntry>();
  #bytes = 0;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Set when a write failed and the cache is known not to be on disk. */
  #persistFailed = false;

  constructor() {
    const raw = getJSON<Record<string, unknown>>(KEY, {});
    for (const [path, value] of Object.entries(raw)) {
      if (isValidEntry(value)) this.#entries.set(path, value);
    }
    this.#recount();
    this.#evict();
  }

  get size(): number {
    return this.#entries.size;
  }

  get approxBytes(): number {
    return this.#bytes;
  }

  get persisted(): boolean {
    return !this.#persistFailed;
  }

  /** Returns the cached text only when it belongs to the given sha. */
  get(path: string, sha: string): string | null {
    const entry = this.#entries.get(path);
    if (!entry) return null;
    if (sha !== '' && entry.sha !== sha) return null;
    entry.at = Date.now();
    return entry.text;
  }

  has(path: string, sha: string): boolean {
    const entry = this.#entries.get(path);
    return entry !== undefined && (sha === '' || entry.sha === sha);
  }

  set(path: string, sha: string, text: string): void {
    if (text.length > MAX_ENTRY_CHARS) {
      // Too big to hold on to; drop any stale copy so a later read refetches.
      this.delete(path);
      return;
    }
    const existing = this.#entries.get(path);
    if (existing) {
      this.#bytes -= existing.text.length;
    }
    this.#entries.set(path, { sha, text, at: Date.now() });
    this.#bytes += text.length;
    this.#dirty = true;
    this.#evict();
    this.#schedule();
  }

  delete(path: string): void {
    const existing = this.#entries.get(path);
    if (!existing) return;
    this.#bytes -= existing.text.length;
    this.#entries.delete(path);
    this.#dirty = true;
    this.#schedule();
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
    this.#dirty = true;
    this.flush();
  }

  /**
   * Drop every entry under `prefix` that is not under `keepPrefix`.
   *
   * Used to retire a session's previous chunk generation in one pass. The
   * alternative — remembering which generation we last loaded and deleting that
   * one specifically — does not survive a reload: the entries live in
   * localStorage, the memory of them does not. Sweeping by shape instead means a
   * phone that has been closed since before a rebuild still clears the dead
   * entries the first time it reads the new head.
   *
   * Returns how many entries were dropped. Both prefixes must be non-empty; an
   * empty `keepPrefix` would match nothing worth keeping, so it is refused
   * rather than allowed to empty the cache.
   */
  evictExcept(prefix: string, keepPrefix: string): number {
    if (prefix === '' || keepPrefix === '') return 0;

    let dropped = 0;
    for (const [key, entry] of [...this.#entries]) {
      if (!key.startsWith(prefix) || key.startsWith(keepPrefix)) continue;
      this.#entries.delete(key);
      this.#bytes -= entry.text.length;
      dropped += 1;
    }

    if (dropped > 0) {
      this.#dirty = true;
      this.#schedule();
    }
    return dropped;
  }

  /** Force a synchronous write. Also called when the tab is hidden. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#dirty) return;

    const payload: Record<string, CacheEntry> = {};
    for (const [path, entry] of this.#entries) payload[path] = entry;

    const written = this.#write(JSON.stringify(payload));
    if (written) {
      this.#dirty = false;
      this.#persistFailed = false;
      return;
    }

    // Almost certainly quota. Halve the cache and try once more; if that fails,
    // keep working from memory.
    this.#persistFailed = true;
    this.#evict(this.#bytes / 2);
    const retryPayload: Record<string, CacheEntry> = {};
    for (const [path, entry] of this.#entries) retryPayload[path] = entry;
    if (this.#write(JSON.stringify(retryPayload))) {
      this.#dirty = false;
      this.#persistFailed = false;
    }
  }

  #write(serialized: string): boolean {
    try {
      globalThis.localStorage?.setItem(KEY, serialized);
      return true;
    } catch {
      return false;
    }
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  #recount(): void {
    this.#bytes = 0;
    for (const entry of this.#entries.values()) this.#bytes += entry.text.length;
  }

  #evict(targetBytes = MAX_BYTES): void {
    if (this.#bytes <= targetBytes && this.#entries.size <= MAX_ENTRIES) return;

    // Every entry is an immutable chunk, so all of them are equally evictable;
    // the least recently read goes first.
    const evictable = [...this.#entries.entries()].sort((a, b) => a[1].at - b[1].at);

    for (const [path, entry] of evictable) {
      if (this.#bytes <= targetBytes * 0.8 && this.#entries.size <= MAX_ENTRIES) break;
      this.#entries.delete(path);
      this.#bytes -= entry.text.length;
    }

    this.#dirty = true;
  }
}

export const blobCache = new BlobCache();
