/**
 * The liveness contract published to the phone.
 *
 * The phone cannot tell a stopped bridge from a reachable relay — Gitee answers
 * `200` for hours after the PC stops publishing — so it reads a heartbeat out
 * of these two files. The field being *optional* in the wire type is what makes
 * this worth pinning: nothing forces the writer to emit it, and a writer that
 * quietly stopped would leave the phone reporting `stale` forever.
 */

import { describe, expect, it } from 'vitest';

import { buildRelayIndex, buildSessionHead } from '../src/index.js';
import type { SessionIndexEntry, SessionState } from '@ccr/shared';

const NOW = new Date('2026-10-14T09:30:00.000Z');

const state: SessionState = {
  sessionId: 'sess-1',
  project: 'E:\\CCCLI_remote',
  title: 'Fix the relay',
  status: 'idle',
  waitingFor: null,
  model: 'claude-sonnet-5-5',
  gitBranch: 'master',
  controllable: true,
  updatedAt: '2026-10-13T10:00:00.000Z',
};

const range = {
  chunkFirst: 1,
  chunkLast: 2,
  firstSeq: 0,
  lastSeq: 40,
  retainedBytes: 4096,
  droppedEvents: 0,
};

const entry: SessionIndexEntry = {
  sessionId: 'sess-1',
  project: 'E:\\CCCLI_remote',
  title: 'Fix the relay',
  status: 'idle',
  updatedAt: '2026-10-13T10:00:00.000Z',
  lastSeq: 40,
  controllable: true,
};

describe('buildSessionHead', () => {
  it('carries the writer’s clock, not the session’s', () => {
    const head = buildSessionHead(state, range, NOW);
    expect(head.heartbeat).toBe(NOW.toISOString());
    // The session has been idle since yesterday; the heartbeat must not.
    expect(head.heartbeat).not.toBe(head.updatedAt);
  });

  it('keeps everything the session itself reports', () => {
    const head = buildSessionHead(state, range, NOW);
    expect(head.sessionId).toBe('sess-1');
    expect(head.status).toBe('idle');
    expect(head.chunkLast).toBe(2);
    expect(head.lastSeq).toBe(40);
  });
});

describe('buildRelayIndex', () => {
  it('carries a heartbeat as well as generatedAt', () => {
    const index = buildRelayIndex({ sessions: [entry], injectionEnabled: true, now: NOW });
    expect(index.heartbeat).toBe(NOW.toISOString());
    expect(index.generatedAt).toBe(NOW.toISOString());
  });

  it('passes the session list and the injection policy through unchanged', () => {
    const index = buildRelayIndex({ sessions: [entry], injectionEnabled: false, now: NOW });
    expect(index.sessions).toEqual([entry]);
    expect(index.injectionEnabled).toBe(false);
    expect(index.version).toBe(1);
  });
});
