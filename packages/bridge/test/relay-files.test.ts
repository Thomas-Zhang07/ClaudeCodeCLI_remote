/**
 * The liveness contract published to the phone.
 *
 * The phone cannot tell a stopped bridge from a reachable relay — Gitee answers
 * `200` for hours after the PC stops publishing — so it reads a heartbeat out
 * of these two files. The field being *optional* in the wire type is what makes
 * this worth pinning: nothing forces the writer to emit it, and a writer that
 * quietly stopped would leave the phone reporting `stale` forever.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChunkWriter } from '../src/chunker.js';
import { buildRelayIndex, buildSessionHead } from '../src/index.js';
import type { NormalizedEvent, SessionIndexEntry, SessionState } from '@ccr/shared';

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
  generation: '9f2c41ab77de0135',
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
    const head = buildSessionHead({ state, range, now: NOW, injectionEnabled: true });
    expect(head.heartbeat).toBe(NOW.toISOString());
    // The session has been idle since yesterday; the heartbeat must not.
    expect(head.heartbeat).not.toBe(head.updatedAt);
  });

  it('keeps everything the session itself reports', () => {
    const head = buildSessionHead({ state, range, now: NOW, injectionEnabled: true });
    expect(head.sessionId).toBe('sess-1');
    expect(head.status).toBe('idle');
    expect(head.chunkLast).toBe(2);
    expect(head.lastSeq).toBe(40);
  });

  it('publishes the chunk series’ generation', () => {
    // The phone keys its chunk cache by this, so a head that omitted it would
    // put every reader back on the weak path — serving cached chunks from a
    // series the bridge has since rebuilt.
    const head = buildSessionHead({ state, range, now: NOW, injectionEnabled: true });
    expect(head.generation).toBe('9f2c41ab77de0135');
  });

  it('carries the injection policy, so an open session knows it can be written to', () => {
    // The head is the only file polled while a session is open. A reader that
    // opened straight into one — a deep link, a reload — has no index to learn
    // this from, and without it reports "prompts are off on the PC" about a
    // relay that has them on.
    expect(buildSessionHead({ state, range, now: NOW, injectionEnabled: false }).injectionEnabled).toBe(
      false,
    );
    expect(buildSessionHead({ state, range, now: NOW, injectionEnabled: true }).injectionEnabled).toBe(
      true,
    );
  });

  /**
   * The end of the chain the phone depends on, exercised rather than assumed:
   * writer → range → head. The two halves of this contract are tested in
   * different packages that share no build, so the join between them is worth
   * pinning from the writer's side.
   */
  it('carries the writer’s token through a restart, and a new one after a rebuild', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-head-'));
    const event: NormalizedEvent = {
      seq: 0,
      ts: '2026-10-13T10:00:00.000Z',
      sessionId: 'sess-1',
      agentId: null,
      kind: 'assistant_text',
      text: 'hello',
    };

    const first = new ChunkWriter({ dir });
    await first.open('sess-1');
    await first.append(event);
    await first.finish();
    const before = buildSessionHead({
      state,
      range: first.range,
      now: NOW,
      injectionEnabled: true,
    });

    const restarted = new ChunkWriter({ dir });
    await restarted.open('sess-1');
    const afterRestart = buildSessionHead({
      state,
      range: restarted.range,
      now: NOW,
      injectionEnabled: true,
    });
    expect(afterRestart.generation).toBe(before.generation);

    await rm(dir, { recursive: true, force: true });
    const rebuilt = new ChunkWriter({ dir });
    await rebuilt.open('sess-1');
    const afterRebuild = buildSessionHead({
      state,
      range: rebuilt.range,
      now: NOW,
      injectionEnabled: true,
    });
    expect(afterRebuild.generation).not.toBe(before.generation);
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
