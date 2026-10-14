/**
 * The rule for obeying a stop request.
 *
 * Two processes act on this file and only one of them is the one being asked:
 * `ccr` writes the pid of the bridge it started, and every bridge that reads the
 * file has to decide whether the request is about *it*. Getting that wrong is not
 * a small failure — a request left behind by a crashed `ccr` would stop whichever
 * bridge started next, which is the same class of bug the request exists to fix.
 *
 * The pid alone is not enough either. Pids are reused, so a request only means
 * something while it is recent, and the age limit has to be checked against a
 * time the file actually carries: treating an unreadable timestamp as "just now"
 * would make an ancient file immortal.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STOP_REQUEST_MAX_AGE_MS,
  clearStopRequest,
  isStopRequestFor,
  readStopRequest,
  stopRequestPath,
  writeStopRequest,
} from '../src/stop-request.js';

const NOW = 1_700_000_000_000;
const SELF = 4242;

describe('isStopRequestFor', () => {
  it('accepts a fresh request naming this process', () => {
    expect(isStopRequestFor({ pid: SELF, at: NOW - 500 }, SELF, NOW)).toBe(true);
  });

  it('refuses a request naming a different bridge', () => {
    expect(isStopRequestFor({ pid: SELF + 1, at: NOW }, SELF, NOW)).toBe(false);
  });

  it('refuses a request with no pid, which is how a corrupt file reads', () => {
    expect(isStopRequestFor({ at: NOW }, SELF, NOW)).toBe(false);
    expect(isStopRequestFor(null, SELF, NOW)).toBe(false);
  });

  it('refuses a request older than the window, because pids are reused', () => {
    expect(isStopRequestFor({ pid: SELF, at: NOW - STOP_REQUEST_MAX_AGE_MS - 1 }, SELF, NOW)).toBe(
      false,
    );
    expect(isStopRequestFor({ pid: SELF, at: NOW - STOP_REQUEST_MAX_AGE_MS }, SELF, NOW)).toBe(true);
  });

  it('refuses a request that names no time at all', () => {
    // Read as "just now" this would be a file that can never go stale, and the
    // only reason to have an age limit is that it can.
    expect(isStopRequestFor({ pid: SELF }, SELF, NOW)).toBe(false);
    expect(isStopRequestFor({ pid: SELF, at: Number.NaN }, SELF, NOW)).toBe(false);
  });
});

describe('the file', () => {
  it('reads back what was written, and nothing when there is nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-stop-'));

    expect(await readStopRequest(dir)).toBeNull();

    await writeStopRequest(dir, SELF, NOW);
    expect(await readStopRequest(dir)).toEqual({ pid: SELF, at: NOW });
    expect(isStopRequestFor(await readStopRequest(dir), SELF, NOW)).toBe(true);

    await clearStopRequest(dir);
    expect(await readStopRequest(dir)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });

  it('reads a corrupt file as no request, so it cannot stop a bridge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-stop-'));
    await writeFile(stopRequestPath(dir), '{ this is not json');

    expect(await readStopRequest(dir)).toBeNull();
    expect(isStopRequestFor(await readStopRequest(dir), SELF, NOW)).toBe(false);
    // Clearing it is still allowed, and is what a later `ccr` does before asking.
    await clearStopRequest(dir);
    expect(await readStopRequest(dir)).toBeNull();

    await rm(dir, { recursive: true, force: true });
  });
});
