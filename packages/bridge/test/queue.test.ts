/**
 * The ordering promise, and the reason it needs keeping.
 *
 * A sequence number is taken by whoever produced the event and the event is
 * written afterwards, so the two can be interleaved by anything that appends
 * concurrently. Chunks are immutable once published, so an event written ahead
 * of a lower-numbered one is not a transient glitch — it is wrong for as long as
 * that chunk exists.
 *
 * This happened for real: recording a prompt's delivery ran *inside* the loop
 * appending a transcript line's events, so a `user_prompt` numbered 7 and its
 * `turn_start` numbered 8 came out as `7, 9, 8`. Every prompt sent from the
 * phone produced one, and the phone reported the rest of the session as torn.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChunkWriter } from '../src/chunker.js';
import { SerialQueue } from '../src/queue.js';
import type { NormalizedEvent } from '@ccr/shared';

function event(seq: number): NormalizedEvent {
  return {
    seq,
    ts: '2026-10-14T06:03:15.028Z',
    sessionId: 'sess-1',
    agentId: null,
    kind: 'assistant_text',
    text: `event ${seq}`,
  };
}

/** Let every pending continuation run, so nothing here depends on timing luck. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * An append held open until it is named.
 *
 * Keyed by sequence rather than released in order, so a test can say exactly
 * which write happens when instead of relying on how the scheduler interleaves.
 */
function gatedWriter() {
  const written: number[] = [];
  const pending = new Map<number, () => void>();

  return {
    written,
    async append(seq: number): Promise<void> {
      await new Promise<void>((resolve) => pending.set(seq, resolve));
      written.push(seq);
    },
    /** Release the append for `seq`, if it has been attempted yet. */
    settle(seq: number): void {
      pending.get(seq)?.();
    },
  };
}

describe('SerialQueue', () => {
  it('runs queued work in order, one at a time', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];

    const first = queue.run(async () => {
      order.push('first:start');
      await Promise.resolve();
      order.push('first:end');
    });
    const second = queue.run(async () => {
      order.push('second:start');
      await Promise.resolve();
      order.push('second:end');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps going after a task throws', async () => {
    const queue = new SerialQueue();
    const ran: string[] = [];

    const failed = queue.run(async () => {
      throw new Error('append failed');
    });
    await expect(failed).rejects.toThrow('append failed');

    // One bad append must not wedge a session's stream forever.
    await queue.run(async () => {
      ran.push('after');
    });
    expect(ran).toEqual(['after']);
  });
});

describe('a batch and a concurrent append', () => {
  /**
   * The bug, reproduced on purpose.
   *
   * Pinning it here means that the day someone removes the queue, a test says
   * why it was there — rather than a phone showing a session torn in half.
   */
  it('unserialised, the later number is written inside the batch', async () => {
    const writer = gatedWriter();

    const batch = (async (): Promise<void> => {
      await writer.append(7);
      await writer.append(8);
    })();
    const synthetic = (async (): Promise<void> => {
      await writer.append(9);
    })();

    writer.settle(7);
    await tick(); // 7 written, the batch moves on to 8
    writer.settle(9);
    await tick(); // 9 written, ahead of the 8 already numbered
    writer.settle(8);
    await tick();

    await Promise.all([batch, synthetic]);
    expect(writer.written).toEqual([7, 9, 8]);
  });

  it('through the queue, the batch is written whole', async () => {
    const queue = new SerialQueue();
    const writer = gatedWriter();

    const batch = queue.run(async () => {
      await writer.append(7);
      await writer.append(8);
    });
    const synthetic = queue.run(async () => {
      await writer.append(9);
    });

    await tick(); // the batch starts; the synthetic write waits behind it
    writer.settle(7);
    await tick();
    writer.settle(8);
    await tick(); // the batch is done, so the queue lets the next writer in
    writer.settle(9);
    await tick();

    await Promise.all([batch, synthetic]);
    expect(writer.written).toEqual([7, 8, 9]);
  });

  /**
   * The same promise through the real writer, asserted where the phone reads it:
   * a chunk file's sequence numbers must ascend.
   */
  it('lands in the chunk file in ascending order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-order-'));
    const queue = new SerialQueue();
    const writer = new ChunkWriter({ dir });
    await writer.open('sess-1');

    await Promise.all([
      queue.run(async () => {
        await writer.append(event(0));
        await writer.append(event(1));
      }),
      queue.run(() => writer.append(event(2))),
    ]);
    await writer.finish();

    const seqs = (await readFile(join(dir, 'events-0001.jsonl'), 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { t?: string; seq?: number })
      .filter((entry) => entry.t !== 'chunk_end')
      .map((entry) => entry.seq);

    expect(seqs).toEqual([0, 1, 2]);

    await rm(dir, { recursive: true, force: true });
  });
});
