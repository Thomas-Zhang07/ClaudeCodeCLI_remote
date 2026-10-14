/**
 * The shared verdict on whether a bridge is running.
 *
 * Two processes act on this and they must not disagree: the bridge refuses to
 * start on a live lock, and `ccr` starts one only when there is none. A `ccr`
 * that is more eager than the bridge spawns a process that exits immediately,
 * leaving a session nobody is watching; one that is lazier declines to start a
 * bridge at all, which is just as quiet. Both look identical from the terminal,
 * which is why the rule is tested rather than assumed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { lockAgeMs, lockIsLive, lockPath, readLock } from '../src/lock.js';

const NOW = 1_700_000_000_000;
const STALE_MS = 20_000;

describe('lockAgeMs', () => {
  it('measures from the heartbeat', () => {
    expect(lockAgeMs({ heartbeat: NOW - 5_000 }, NOW)).toBe(5_000);
  });

  it('is infinite when there is no usable timestamp', () => {
    // A file that names no time is not evidence of a live writer, and treating
    // it as "just refreshed" would refuse to start a bridge forever.
    expect(lockAgeMs(null, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(lockAgeMs({}, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(lockAgeMs({ heartbeat: Number.NaN }, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('lockIsLive', () => {
  it('is live while the heartbeat is fresh', () => {
    expect(lockIsLive({ heartbeat: NOW - 1_000 }, STALE_MS, NOW)).toBe(true);
  });

  it('goes stale once the holder stops refreshing it', () => {
    // This is the orphan case the heartbeat exists for: the parent that started
    // the bridge is gone, but the bridge is still writing, so the check is on
    // the timestamp and not on any pid.
    expect(lockIsLive({ heartbeat: NOW - STALE_MS }, STALE_MS, NOW)).toBe(false);
    expect(lockIsLive({ heartbeat: NOW - STALE_MS - 1 }, STALE_MS, NOW)).toBe(false);
  });

  it('is not live when there is no lock at all', () => {
    expect(lockIsLive(null, STALE_MS, NOW)).toBe(false);
  });
});

describe('readLock', () => {
  it('returns null when there is no lock, which is the normal case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-lock-'));
    expect(await readLock(dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for a lock that will not parse', async () => {
    // A corrupt file must not be able to keep the bridge from ever starting.
    const dir = await mkdtemp(join(tmpdir(), 'ccr-lock-'));
    await writeFile(lockPath(dir), '{ not json');
    expect(await readLock(dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('reads back what the bridge wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-lock-'));
    await writeFile(
      lockPath(dir),
      JSON.stringify({ pid: 4242, heartbeat: NOW, startedAt: '2026-10-14T06:00:00.000Z' }),
    );

    const lock = await readLock(dir);
    expect(lock?.pid).toBe(4242);
    expect(lockIsLive(lock, STALE_MS, NOW)).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });
});
