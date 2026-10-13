/**
 * localStorage access that never throws.
 *
 * Safari in private mode, and any browser with site data blocked, throws from
 * `localStorage` on *access* rather than returning null. Every read and write in
 * the app goes through here so a locked-down browser degrades to "no cache"
 * instead of a blank screen.
 */

export function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    // Quota exceeded, or storage disabled entirely.
    return false;
  }
}

export function safeRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Nothing useful to do.
  }
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = safeGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setJSON(key: string, value: unknown): boolean {
  try {
    return safeSet(key, JSON.stringify(value));
  } catch {
    return false;
  }
}
