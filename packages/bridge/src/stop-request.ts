/**
 * Asking a bridge to stop, and what it means to be asked.
 *
 * `ccr` starts a bridge when there is not one, and stops the one it started when
 * its session ends. That second half used to be a signal, and on Windows there
 * are none: `child.kill()` is a `TerminateProcess`, so the bridge died between
 * two ticks with a `head.json` on disk still claiming the session was active and
 * nothing published. The phone then showed that session as active for as long as
 * Gitee kept answering — which is forever.
 *
 * So the stop is a **request** rather than a signal. The bridge answers it by
 * finishing its own work — a last registry read, a last head, a last publish —
 * and exiting by itself.
 *
 * Two processes have to agree on this file, which is why it lives in its own
 * module rather than inside either of them.
 *
 * **The request names a pid.** `ccr` writes the pid of the bridge it started,
 * and a bridge honours a request only when the pid is its own: a request left
 * behind by a crashed `ccr` must not be able to take down whichever bridge comes
 * next. The age limit is the same guard from the other side — a pid can be
 * reused, and a request from an hour ago is not about this process.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StopRequest {
  /** The bridge being asked to stop. */
  pid?: number;
  /** When the request was written, in epoch milliseconds. */
  at?: number;
}

/**
 * How old a request may be and still be about the process reading it.
 *
 * The request is written immediately before `ccr` waits for the bridge, and the
 * wait is seconds — so this is not a timeout anything is racing, only a floor
 * under "this can never mean me".
 */
export const STOP_REQUEST_MAX_AGE_MS = 60_000;

export function stopRequestPath(stateDir: string): string {
  return join(stateDir, 'bridge-stop-request.json');
}

/**
 * Write a request naming the bridge to stop.
 *
 * Overwrites: a leftover from an earlier session names an older pid, and leaving
 * it in place while writing a second one is how a file ends up describing
 * neither.
 */
export async function writeStopRequest(
  stateDir: string,
  pid: number,
  now: number = Date.now(),
): Promise<void> {
  await writeFile(stopRequestPath(stateDir), JSON.stringify({ pid, at: now }));
}

/**
 * Read the request, or null when there is none or it will not parse.
 *
 * Unreadable is deliberately indistinguishable from absent: a corrupt file must
 * not be able to stop a bridge, and there is nothing here worth reporting.
 */
export async function readStopRequest(stateDir: string): Promise<StopRequest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stopRequestPath(stateDir), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as StopRequest;
  } catch {
    return null;
  }
}

export async function clearStopRequest(stateDir: string): Promise<void> {
  await rm(stopRequestPath(stateDir), { force: true }).catch(() => {});
}

/**
 * Whether this request is addressed to `pid` and recent enough to act on.
 *
 * Pure, and the only copy of the rule: the process that writes the file and the
 * process that obeys it are different ones, so the check cannot live in either.
 */
export function isStopRequestFor(
  request: StopRequest | null,
  pid: number,
  now: number = Date.now(),
  maxAgeMs: number = STOP_REQUEST_MAX_AGE_MS,
): boolean {
  const target = request?.pid;
  const at = request?.at;

  if (typeof target !== 'number' || !Number.isFinite(target) || target !== pid) return false;
  // A request that names no time is not evidence of anything, and reading it as
  // "just now" would let an ancient file stop a bridge.
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return now - at <= maxAgeMs;
}
