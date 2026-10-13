/**
 * Blob cache, keyed by repository path.
 *
 * The relay's tree endpoint gives a sha per blob; comparing that against what we
 * already hold is what turns a revisit into zero content requests. Entries are
 * written to localStorage so reopening the PWA paints from the last known state
 * instead of from an empty screen.
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
/** Nothing this large is worth keeping around; chunks above it are re-fetchable. */
const MAX_ENTRY_CHARS = 400_000;
const WRITE_DEBOUNCE_MS = 900;

/** Small, always-useful files: never evicted while a session is being read. */
function isPinned(path: string): boolean {
  return (
    path.endsWith('/index.json') ||
    path.endsWith('/state.json') ||
    path.endsWith('/manifest.json') ||
    path.endsWith('/subagents.json') ||
    path === 'out/index.json'
  );
}

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

    const evictable = [...this.#entries.entries()]
      .filter(([path]) => !isPinned(path))
      .sort((a, b) => a[1].at - b[1].at);

    for (const [path, entry] of evictable) {
      if (this.#bytes <= targetBytes * 0.8 && this.#entries.size <= MAX_ENTRIES) break;
      this.#entries.delete(path);
      this.#bytes -= entry.text.length;
    }

    this.#dirty = true;
  }
}

export const blobCache = new BlobCache();
