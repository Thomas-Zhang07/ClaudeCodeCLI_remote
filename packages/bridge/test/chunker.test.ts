import { appendFile, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChunkWriter, chunkFilename, crc32, sha256 } from '../src/chunker.js';
import { MAX_EVENT_BYTES } from '@ccr/shared';
import type { ChunkEntry, ChunkManifest, NormalizedEvent, SessionState } from '@ccr/shared';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccr-chunk-'));
});

function event(seq: number, pad = 0): NormalizedEvent {
  return {
    seq,
    ts: '2026-10-13T10:00:00.000Z',
    sessionId: 'sess-1',
    agentId: null,
    kind: 'assistant_text',
    text: 'x'.repeat(pad),
  };
}

function state(): SessionState {
  return {
    sessionId: 'sess-1',
    project: null,
    title: null,
    status: 'idle',
    waitingFor: null,
    model: null,
    gitBranch: null,
    controllable: false,
    updatedAt: '2026-10-13T10:00:00.000Z',
  };
}

async function readManifest(): Promise<ChunkManifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ChunkManifest;
}

describe('crc32', () => {
  it('matches the known digest for a fixed input', () => {
    // Standard check value.
    expect(crc32(Buffer.from('123456789'))).toBe('cbf43926');
  });
});

describe('ChunkWriter', () => {
  it('appends events and writes them as one JSON object per line', async () => {
    const w = new ChunkWriter({ dir });
    await w.open('sess-1');
    await w.append(event(1));
    await w.append(event(2));
    await w.finish(state());

    const text = await readFile(join(dir, chunkFilename(1)), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(3); // two events plus the sentinel
    expect(JSON.parse(lines[0]!).seq).toBe(1);
    expect(JSON.parse(lines[2]!).t).toBe('chunk_end');
  });

  it('terminates a chunk with a sentinel carrying its line count', async () => {
    const w = new ChunkWriter({ dir });
    await w.open('sess-1');
    await w.append(event(1));
    await w.append(event(2));
    await w.seal();

    const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
    const sentinel = JSON.parse(lines.at(-1)!);
    expect(sentinel.t).toBe('chunk_end');
    expect(sentinel.n).toBe(1);
    expect(sentinel.lines).toBe(2);
  });

  it('rolls to a new chunk at the size budget and never rewrites a sealed one', async () => {
    const w = new ChunkWriter({ dir, maxChunkBytes: 200 });
    await w.open('sess-1');

    for (let i = 1; i <= 12; i++) await w.append(event(i, 60));
    await w.finish(state());

    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    expect(files.length).toBeGreaterThan(1);

    // Every sealed chunk ends with its sentinel — the mark of completeness.
    for (const file of files) {
      const lines = (await readFile(join(dir, file), 'utf8')).trim().split('\n');
      const last = JSON.parse(lines.at(-1)!);
      expect(last.t, `${file} should be sealed`).toBe('chunk_end');
    }
  });

  it('records a digest and sequence range per chunk in the manifest', async () => {
    const w = new ChunkWriter({ dir, maxChunkBytes: 200 });
    await w.open('sess-1');
    for (let i = 1; i <= 12; i++) await w.append(event(i, 60));
    await w.finish(state());

    const manifest = await readManifest();
    expect(manifest.sessionId).toBe('sess-1');
    expect(manifest.chunks.length).toBeGreaterThan(0);

    for (const chunk of manifest.chunks) {
      const bytes = await readFile(join(dir, chunkFilename(chunk.n)));
      expect(chunk.sha256).toBe(sha256(bytes));
      expect(chunk.bytes).toBe(bytes.length);
    }
  });

  it('keeps sequence ranges contiguous across chunks', async () => {
    const w = new ChunkWriter({ dir, maxChunkBytes: 200 });
    await w.open('sess-1');
    for (let i = 1; i <= 12; i++) await w.append(event(i, 60));
    await w.finish(state());

    const { chunks } = await readManifest();
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.firstSeq).toBe(chunks[i - 1]!.lastSeq + 1);
    }
  });

  describe('readLastMainKind', () => {
    const withAgent = (seq: number, kind: string, agentId: string | null): NormalizedEvent => ({
      ...event(seq),
      kind: 'assistant_text',
      agentId,
      ...(kind === 'assistant_text' ? {} : {}),
    });

    it('returns the kind of the last main-thread event', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append(event(0));
      await w.append({ ...event(1), kind: 'turn_end' });
      await w.finish();

      expect(await w.readLastMainKind()).toBe('turn_end');
    });

    it('ignores subagent events, which arrive on their own schedule', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append({ ...event(0), kind: 'turn_end' });
      await w.append({ ...event(1), kind: 'assistant_text', agentId: 'agent-x' });
      await w.finish();

      // The subagent spoke last, but the main thread is what matters.
      expect(await w.readLastMainKind()).toBe('turn_end');
    });

    it('reports the last event, not the sentinel that follows it', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append(event(0));
      await w.finish();

      // The helper's default kind; the point is that the sentinel is skipped
      // rather than reported as the last thing that happened.
      expect(await w.readLastMainKind()).toBe('assistant_text');
    });

    it('returns null for a session with nothing recorded', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      expect(await w.readLastMainKind()).toBeNull();
    });

    it('looks past a chunk holding only subagent events', async () => {
      const w = new ChunkWriter({ dir, maxChunkBytes: 120 });
      await w.open('sess-1');
      await w.append({ ...event(0), kind: 'turn_end' });
      await w.append({ ...event(1), kind: 'assistant_text', agentId: 'a', text: 'x'.repeat(90) });
      await w.finish();

      expect(await w.readLastMainKind()).toBe('turn_end');
    });

    it('survives a torn final line', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append({ ...event(0), kind: 'turn_end' });
      await w.finish();

      // A crash mid-write leaves a partial line behind.
      await appendFile(join(dir, chunkFilename(1)), '{"kind":"assist');

      expect(await w.readLastMainKind()).toBe('turn_end');
    });

    it('recovers the value after a restart, with no persisted state', async () => {
      const first = new ChunkWriter({ dir });
      await first.open('sess-1');
      await first.append({ ...event(0), kind: 'turn_end' });
      await first.finish();

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');

      expect(await second.readLastMainKind()).toBe('turn_end');
    });

    /**
     * The bridge synthesizes a few kinds about its own bookkeeping. They are not
     * something the session *did*, and letting one answer that question wedged
     * sessions shut: a recorded refusal is itself an `injection` event, so the
     * session looked permanently mid-turn and refusing again appended another.
     */
    describe('bridge-synthesized events', () => {
      const synthesized = (
        seq: number,
        kind: string,
        extra: Record<string, unknown>,
      ): NormalizedEvent => ({ ...event(seq), kind, ...extra }) as NormalizedEvent;

      it('leaves a finished turn in place when a title changes', async () => {
        const w = new ChunkWriter({ dir });
        await w.open('sess-1');
        await w.append({ ...event(0), kind: 'turn_end' });
        await w.append(synthesized(1, 'title', { title: 'Renamed', source: 'ai' }));
        await w.finish();

        // `ai-title` re-fires constantly and arrives between turns. If it
        // answered this question, the guard would refuse a session that has
        // plainly finished.
        expect(await w.readLastMainKind()).toBe('turn_end');
      });

      it('does not let the record of a prompt’s fate become session activity', async () => {
        const w = new ChunkWriter({ dir });
        await w.open('sess-1');
        await w.append({ ...event(0), kind: 'turn_end' });
        await w.append(
          synthesized(1, 'injection', { promptId: 'p1', state: 'rejected', detail: 'nope' }),
        );
        await w.finish();

        expect(await w.readLastMainKind()).toBe('turn_end');
      });

      it('ignores an attention note', async () => {
        const w = new ChunkWriter({ dir });
        await w.open('sess-1');
        await w.append({ ...event(0), kind: 'turn_end' });
        await w.append(synthesized(1, 'attention', { text: 'waiting', level: 'waiting' }));
        await w.finish();

        expect(await w.readLastMainKind()).toBe('turn_end');
      });

      it('still reports a session whose only events are synthesized as unknown', async () => {
        const w = new ChunkWriter({ dir });
        await w.open('sess-1');
        await w.append(synthesized(0, 'injection', { promptId: 'p1', state: 'rejected' }));
        await w.finish();

        // Nothing transcript-side has happened, so there is no answer — and the
        // guard treats "unknown" as refusing rather than as idle.
        expect(await w.readLastMainKind()).toBeNull();
      });
    });
  });

  it('refuses an event over MAX_EVENT_BYTES, before touching the chunk', async () => {
    // The ceiling is asserted by the writer rather than merely documented: a
    // field that escaped truncation would otherwise be discovered only when the
    // relay bloated.
    const w = new ChunkWriter({ dir });
    await w.open('sess-1');

    const huge: NormalizedEvent = { ...event(0), text: 'x'.repeat(MAX_EVENT_BYTES) };
    await expect(w.append(huge)).rejects.toThrow(/MAX_EVENT_BYTES/);

    // Rejected before any state moved, so the chunk is still empty and the
    // writer can carry on.
    expect(existsSync(join(dir, chunkFilename(1)))).toBe(false);
    await w.append(event(1));
    await w.finish();
    expect((await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('reports a chunk range the reader can trust', async () => {
    // The reader has no file listing; this range is how it knows what exists.
    const w = new ChunkWriter({ dir });
    await w.open('sess-1');
    await w.append(event(1));
    await w.finish();

    const range = w.range;
    expect(range.chunkFirst).toBe(1);
    expect(range.chunkLast).toBe(1);
    expect(range.lastSeq).toBe(1);
    expect(range.droppedEvents).toBe(0);

    // The advertised chunk must actually exist and be sealed.
    const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines.at(-1)!).t).toBe('chunk_end');
  });

  describe('a chunk that begins at sequence zero', () => {
    it('signs the sentinel with sequence 0, not the second event sequence', async () => {
      // Regression. `firstSeq` used 0 as its "nothing seen yet" marker, but 0 is
      // a real sequence — a session's first event is seq 0. The sentinel was
      // therefore signed over the *second* event's sequence, while the reader
      // derives it from the chunk's actual first event, so the checksum never
      // matched and the reader rejected the whole chunk and showed nothing.
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append(event(0));
      await w.append(event(1));
      await w.finish();

      const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
      const sentinel = JSON.parse(lines.at(-1)!);

      expect(sentinel.lines).toBe(2);
      expect(sentinel.crc32).toBe(crc32(Buffer.from(`0:${sentinel.lines}`)));
      expect(sentinel.crc32).not.toBe(crc32(Buffer.from(`1:${sentinel.lines}`)));
    });

    it('reports firstSeq 0 in the range', async () => {
      const w = new ChunkWriter({ dir });
      await w.open('sess-1');
      await w.append(event(0));
      await w.append(event(1));
      await w.finish();

      expect(w.range.firstSeq).toBe(0);
      expect(w.range.lastSeq).toBe(1);

      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      expect(manifest.chunks[0].firstSeq).toBe(0);
      expect(manifest.chunks[0].lastSeq).toBe(1);
    });

    it('recovers sequence 0 from a partial chunk after a crash', async () => {
      const first = new ChunkWriter({ dir });
      await first.open('sess-1');
      await first.append(event(0));
      // No seal: this is what a crash leaves behind.

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');

      await second.append(event(1));
      await second.finish();

      const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
      const sentinel = JSON.parse(lines.at(-1)!);
      expect(sentinel.crc32).toBe(crc32(Buffer.from(`0:${sentinel.lines}`)));
    });
  });

  describe('retention', () => {
    it('deletes the oldest chunk and advances chunkFirst', async () => {
      const w = new ChunkWriter({ dir, maxChunkBytes: 120, retainBytes: 400 });
      await w.open('sess-1');
      for (let i = 1; i <= 40; i++) await w.append(event(i, 60));
      await w.finish();

      const range = w.range;
      expect(range.chunkFirst).toBeGreaterThan(1);
      expect(range.droppedEvents).toBeGreaterThan(0);
      expect(range.retainedBytes).toBeLessThanOrEqual(400 + 200);

      // Pruned chunks are gone from disk, not rewritten.
      expect(existsSync(join(dir, chunkFilename(1)))).toBe(false);
    });

    it('never deletes the newest chunk, even alone over budget', async () => {
      // A session that retains nothing cannot be read at all. One oversized
      // chunk is better than an empty session.
      const w = new ChunkWriter({ dir, maxChunkBytes: 60, retainBytes: 1 });
      await w.open('sess-1');
      for (let i = 1; i <= 4; i++) await w.append(event(i, 40));
      await w.finish();

      expect(w.range.chunkLast).toBeGreaterThanOrEqual(w.range.chunkFirst);
      expect(existsSync(join(dir, chunkFilename(w.range.chunkLast)))).toBe(true);
    });

    it('leaves survivors sealed and contiguous', async () => {
      const w = new ChunkWriter({ dir, maxChunkBytes: 120, retainBytes: 400 });
      await w.open('sess-1');
      for (let i = 1; i <= 30; i++) await w.append(event(i, 60));
      await w.finish();

      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      const kept: ChunkEntry[] = manifest.chunks;

      expect(kept.length).toBeGreaterThan(0);
      for (let i = 1; i < kept.length; i++) {
        expect(kept[i]!.firstSeq).toBe(kept[i - 1]!.lastSeq + 1);
      }
      // Every surviving chunk is still terminable and complete.
      for (const chunk of kept) {
        const lines = (await readFile(join(dir, chunkFilename(chunk.n)), 'utf8')).trim().split('\n');
        expect(JSON.parse(lines.at(-1)!).t).toBe('chunk_end');
      }
    });

    it('makes no change when the session is under budget', async () => {
      const w = new ChunkWriter({ dir, retainBytes: 10 * 1024 * 1024 });
      await w.open('sess-1');
      for (let i = 1; i <= 5; i++) await w.append(event(i, 10));
      await w.finish();

      expect(w.range.chunkFirst).toBe(1);
      expect(w.range.droppedEvents).toBe(0);
    });
  });

  it('survives many rapid seals, which stresses rename-over-existing', async () => {
    // On Windows, replacing a file another process holds open fails with EPERM.
    // Sealing repeatedly rewrites the manifest constantly, which is exactly the
    // pattern that surfaced it.
    const w = new ChunkWriter({ dir, maxChunkBytes: 100 });
    await w.open('sess-1');
    for (let i = 1; i <= 60; i++) await w.append(event(i, 40));
    await w.finish(state());

    const manifest = await readManifest();
    expect(manifest.chunks.length).toBeGreaterThan(5);

    // Every sealed chunk is complete and the stream has no gaps.
    for (let i = 1; i < manifest.chunks.length; i++) {
      expect(manifest.chunks[i]!.firstSeq).toBe(manifest.chunks[i - 1]!.lastSeq + 1);
    }
  });

  describe('recovery from a crash mid-chunk', () => {
    it('resumes the unterminated chunk rather than discarding it', async () => {
      const first = new ChunkWriter({ dir });
      await first.open('sess-1');
      await first.append(event(1));
      await first.append(event(2));
      // No seal: this is the state a crash leaves behind.

      const sizeBefore = (await stat(join(dir, chunkFilename(1)))).size;
      expect(sizeBefore).toBeGreaterThan(0);

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');
      // Sequence position recovered from the file itself.
      expect(second.lastSeq).toBe(2);
      expect(second.chunkNumber).toBe(1);

      await second.append(event(3));
      await second.finish(state());

      const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
      expect(lines.map((l) => JSON.parse(l).seq ?? 'end')).toEqual([1, 2, 3, 'end']);
    });

    it('starts a fresh chunk after a manifest exists', async () => {
      const first = new ChunkWriter({ dir });
      await first.open('sess-1');
      await first.append(event(1));
      await first.seal();

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');
      expect(second.chunkNumber).toBe(2);
      // The highest sequence written, recovered from the sealed chunk — not a
      // counter reset to zero, which would let the writer reissue a sequence.
      expect(second.lastSeq).toBe(1);
    });

    it('cuts a torn final line away instead of appending onto it', async () => {
      // `append` opens with 'a', so a fragment left by a crash would be welded
      // to the next JSON object — `{"kind":"assist{"seq":2,…}`. That line never
      // parses again, and because the sentinel covers the whole chunk the
      // reader rejects all of it, permanently, including the events written
      // before the crash.
      const first = new ChunkWriter({ dir });
      await first.open('sess-1');
      await first.append(event(0));
      await first.append(event(1));
      await appendFile(join(dir, chunkFilename(1)), '{"kind":"assist');

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');
      expect(second.lastSeq).toBe(1);
      await second.append(event(2));
      await second.finish();

      const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(lines.map((l) => JSON.parse(l).seq ?? 'end')).toEqual([0, 1, 2, 'end']);
    });

    it('numbers above the chunks on disk when the manifest is corrupt', async () => {
      // Resetting to chunk 1 would re-enter a chunk the phone has already
      // cached and rewrite it under the same number — invisible to the reader,
      // which is entitled to assume a sealed chunk never changes.
      const first = new ChunkWriter({ dir, maxChunkBytes: 120 });
      await first.open('sess-1');
      for (let i = 1; i <= 12; i++) await first.append(event(i, 60));
      await first.finish();

      const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(1);
      const highest = Math.max(...files.map((f) => Number.parseInt(/events-(\d+)/.exec(f)![1]!, 10)));
      const digest = sha256(await readFile(join(dir, chunkFilename(1))));

      await writeFile(join(dir, 'manifest.json'), '{ this is not json at all');

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');

      expect(second.chunkNumber).toBe(highest + 1);
      await second.append(event(100, 60));
      await second.finish();

      // The already-published chunk is byte-identical to what the reader cached.
      expect(sha256(await readFile(join(dir, chunkFilename(1))))).toBe(digest);
    });

    it('treats a manifest without a chunk list as corrupt', async () => {
      const first = new ChunkWriter({ dir, maxChunkBytes: 120 });
      await first.open('sess-1');
      for (let i = 1; i <= 8; i++) await first.append(event(i, 60));
      await first.finish();

      const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      const highest = Math.max(...files.map((f) => Number.parseInt(/events-(\d+)/.exec(f)![1]!, 10)));

      await writeFile(join(dir, 'manifest.json'), JSON.stringify({ sessionId: 'sess-1' }));

      const second = new ChunkWriter({ dir });
      await second.open('sess-1');
      expect(second.chunkNumber).toBe(highest + 1);
    });
  });
});
