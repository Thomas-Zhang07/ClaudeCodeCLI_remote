import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChunkWriter, chunkFilename, crc32, sha256 } from '../src/chunker.js';
import type { ChunkManifest, NormalizedEvent, SessionState } from '@ccr/shared';

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

  it('advertises chunkLast in state so the reader never chases a missing chunk', async () => {
    const w = new ChunkWriter({ dir });
    await w.open('sess-1');
    await w.append(event(1));
    await w.finish(state());

    const written = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(written.chunkLast).toBe(1);

    // The advertised chunk must actually exist and be sealed.
    const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines.at(-1)!).t).toBe('chunk_end');
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
      expect(second.lastSeq).toBe(0);
    });
  });
});
