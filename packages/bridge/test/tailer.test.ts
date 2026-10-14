import { appendFile, mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Tailer } from '../src/tailer.js';

const OPTIONS = { coldStartBytes: 256 * 1024 };

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccr-tail-'));
  file = join(dir, 'session.jsonl');
  await writeFile(file, '');
});

afterEach(() => {
  // Temp directories are small and the OS reclaims them; nothing to clean up.
});

describe('Tailer', () => {
  it('returns nothing for a file that has not grown', async () => {
    const t = new Tailer(file, OPTIONS);
    expect(await t.poll()).toEqual([]);
    expect(await t.poll()).toEqual([]);
  });

  it('returns complete lines as they are appended', async () => {
    const t = new Tailer(file, OPTIONS);
    await t.poll();

    await appendFile(file, '{"a":1}\n');
    expect(await t.poll()).toEqual(['{"a":1}']);

    await appendFile(file, '{"b":2}\n{"c":3}\n');
    expect(await t.poll()).toEqual(['{"b":2}', '{"c":3}']);
  });

  it('holds back a partial line until its newline arrives', async () => {
    const t = new Tailer(file, OPTIONS);
    await t.poll();

    await appendFile(file, '{"partial":');
    expect(await t.poll()).toEqual([]);
    expect(t.pendingBytes).toBeGreaterThan(0);

    await appendFile(file, 'true}\n');
    expect(await t.poll()).toEqual(['{"partial":true}']);
  });

  it('does not lose or duplicate a torn character at the write boundary', async () => {
    const t = new Tailer(file, OPTIONS);
    await t.poll();

    // Split a multi-byte character across two separate appends.
    const line = Buffer.from('{"t":"中文"}\n', 'utf8');
    await appendFile(file, line.subarray(0, 8));
    expect(await t.poll()).toEqual([]);

    await appendFile(file, line.subarray(8));
    const out = await t.poll();
    expect(out).toEqual(['{"t":"中文"}']);
    expect(out.join('')).not.toContain('�');
  });

  it('resumes from a persisted offset without replaying history', async () => {
    const first = new Tailer(file, OPTIONS);
    await first.poll();
    await appendFile(file, '{"one":1}\n');
    expect(await first.poll()).toEqual(['{"one":1}']);

    // A restart: hand the saved offset to a fresh instance.
    const second = new Tailer(file, OPTIONS, first.getState());
    await appendFile(file, '{"two":2}\n');
    expect(await second.poll()).toEqual(['{"two":2}']);
  });

  it('delivers a line split across a restart exactly once, whole', async () => {
    // The offset persisted is the start of the incomplete line, not the read
    // cursor. Persisting the cursor skips the bytes the framer was still
    // holding — and the framer's buffer does not survive a restart — so the
    // line's head is never read and its tail is framed as a fragment and
    // dropped by the parser.
    const first = new Tailer(file, OPTIONS);
    await first.poll();

    await appendFile(file, '{"half":');
    expect(await first.poll()).toEqual([]);
    expect(first.pendingBytes).toBeGreaterThan(0);

    const second = new Tailer(file, OPTIONS, first.getState());
    await appendFile(file, 'true}\n');
    expect(await second.poll()).toEqual(['{"half":true}']);

    // Whole means whole: the same line is not emitted again on the next poll.
    expect(await second.poll()).toEqual([]);
  });

  it('re-reads a split multi-byte character whole across a restart', async () => {
    const first = new Tailer(file, OPTIONS);
    await first.poll();

    const line = Buffer.from('{"t":"中文"}\n', 'utf8');
    await appendFile(file, line.subarray(0, 10));
    expect(await first.poll()).toEqual([]);

    const second = new Tailer(file, OPTIONS, first.getState());
    await appendFile(file, line.subarray(10));
    const out = await second.poll();

    expect(out).toEqual(['{"t":"中文"}']);
    expect(out.join('')).not.toContain('�');
  });

  it('keeps discarding a cold start’s fragment across a restart', async () => {
    // A cold start lands inside a line and resynchronises at the next newline.
    // If the process ends before that newline arrives, restarting without the
    // skip flag frames the fragment's tail as a line of its own — a bogus
    // record built from the middle of a real one.
    await writeFile(file, 'x'.repeat(1000));
    const first = new Tailer(file, { coldStartBytes: 200 });
    expect(await first.poll()).toEqual([]);

    const second = new Tailer(file, { coldStartBytes: 200 }, first.getState());
    await appendFile(file, 'y}\n');
    expect(await second.poll()).toEqual([]);

    // And the next complete line is delivered normally.
    await appendFile(file, '{"after":1}\n');
    expect(await second.poll()).toEqual(['{"after":1}']);
  });

  it('resets when the file is truncated rather than losing position', async () => {
    const t = new Tailer(file, OPTIONS);
    await t.poll();
    await appendFile(file, '{"before":1}\n');
    expect(await t.poll()).toEqual(['{"before":1}']);

    await truncate(file, 0);
    await appendFile(file, '{"after":1}\n');
    expect(await t.poll()).toEqual(['{"after":1}']);
  });

  it('returns an empty result for a file that does not exist', async () => {
    const t = new Tailer(join(dir, 'nope.jsonl'), OPTIONS);
    expect(await t.poll()).toEqual([]);
    expect(t.missing).toBe(true);
  });

  describe('cold start on a large existing transcript', () => {
    it('starts inside a bounded window and resynchronises on a line boundary', async () => {
      const lines = Array.from({ length: 500 }, (_, i) => `{"i":${i}}`);
      await writeFile(file, lines.map((l) => `${l}\n`).join(''));

      const t = new Tailer(file, { coldStartBytes: 200 });
      const out = await t.poll();

      // It skipped the bulk of the file...
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThan(lines.length);

      // ...and every line it did return is whole, proving it resynchronised
      // rather than emitting the fragment it landed in the middle of.
      for (const line of out) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // The last line of the file must be present.
      expect(out.at(-1)).toBe('{"i":499}');
    });

    it('does not truncate a small file', async () => {
      await writeFile(file, '{"a":1}\n{"b":2}\n');
      const t = new Tailer(file, { coldStartBytes: 1024 });
      expect(await t.poll()).toEqual(['{"a":1}', '{"b":2}']);
    });
  });

  it('caps bytes read per poll so one catch-up cannot stall the loop', async () => {
    const t = new Tailer(file, { coldStartBytes: 0, maxReadBytes: 32 });
    await t.poll();

    const expected = Array.from({ length: 10 }, (_, i) => `{"i":${i}}`);
    await appendFile(file, expected.map((l) => `${l}\n`).join(''));

    const first = await t.poll();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(expected.length);

    // Draining the remainder takes further bounded polls, and loses nothing —
    // the cap must throttle, not drop.
    const rest: string[] = [];
    for (let i = 0; i < 10 && first.length + rest.length < expected.length; i++) {
      rest.push(...(await t.poll()));
    }
    expect([...first, ...rest]).toEqual(expected);
  });
});
