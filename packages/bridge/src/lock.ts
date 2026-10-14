/**
 * The heartbeat lock, and what it means for someone else to hold it.
 *
 * Two processes have to agree on this, which is why it lives in its own module
 * rather than inside the bridge.
 *
 *  - The **bridge** refuses to start while the lock is fresh. Two bridges share
 *    a state directory, a clone and the same chunk files, and the damage is
 *    confusing rather than obvious: chunks end up with a mix of valid and
 *    invalid checksums, which reads as corrupt data rather than as two processes
 *    fighting over it.
 *  - **`ccr`** starts a bridge only when there is not one. It has to reach the
 *    same verdict: if it is more eager than the bridge, it spawns a process that
 *    immediately refuses and exits, leaving a session nobody is watching with
 *    nothing on screen to say so. If it is lazier, it declines to start one and
 *    the session goes unmonitored just as quietly.
 *
 * **A heartbeat, not a pid.** The holder refreshes a timestamp; a newcomer
 * refuses while that timestamp is fresh. A pid cannot answer this: stopping an
 * `npm run` wrapper does not reliably stop the node process it spawned, so the
 * parent whose pid a static lock recorded can be gone while the child it started
 * is still writing. The pid is kept for the message, and is not trusted.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BridgeLock {
  pid?: number;
  /** When the holder last refreshed it, in epoch milliseconds. */
  heartbeat?: number;
  startedAt?: string;
}

export function lockPath(stateDir: string): string {
  return join(stateDir, 'bridge.lock');
}

/**
 * Read the lock, or null when there is none or it will not parse.
 *
 * An unreadable lock is deliberately indistinguishable from an absent one:
 * a corrupt file must not be able to prevent the bridge from starting.
 */
export async function readLock(stateDir: string): Promise<BridgeLock | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath(stateDir), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as BridgeLock;
  } catch {
    return null;
  }
}

/**
 * How long ago the holder last refreshed it.
 *
 * Infinite when the file names no readable time — a lock written by something
 * that never got as far as refreshing it is not evidence of a live writer.
 */
export function lockAgeMs(lock: BridgeLock | null, now: number): number {
  const heartbeat = lock?.heartbeat;
  if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) {
    return Number.POSITIVE_INFINITY;
  }
  return now - heartbeat;
}

/** Whether a live writer holds it, so a newcomer must refuse. */
export function lockIsLive(lock: BridgeLock | null, staleMs: number, now: number = Date.now()): boolean {
  return lockAgeMs(lock, now) < staleMs;
}
