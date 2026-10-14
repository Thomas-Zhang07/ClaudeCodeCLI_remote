/**
 * The writer is pinned, byte for byte, to the canonical chunk fixture.
 *
 * **Why this test exists.** The chunk wire format is implemented twice — the
 * writer here in TypeScript-on-the-PC, the parser in
 * `packages/phone/src/lib/events.ts` — and for a long time nothing but convention
 * held the two together. They did drift once: the sentinel's checksum input was
 * changed on the writer's side only (M8), which by itself would have made *every*
 * chunk fail validation on the phone. See KNOWN-ISSUES #18.
 *
 * `packages/shared/test/fixtures/events-0001.jsonl` is the format's canonical
 * definition: a real, sealed chunk file. This test runs a real `ChunkWriter`
 * against a real temp directory over the same events and asserts the bytes it
 * produces are *identical* to the fixture's. Anything that changes the wire
 * format — a key renamed, a field added, the sentinel's digest input, whitespace
 * in the serialization, a line ending — fails here, in the package that changed,
 * rather than silently on someone's phone.
 *
 * **What this does not cover.** The reader. `packages/phone` has no test runner
 * and resolves imports through `@/*` aliases, so it cannot be loaded from here;
 * the fixture is *documented* for it, not *asserted* against it. A change to the
 * phone's `parseChunk` still fails no test. That is KNOWN-ISSUES #18 and #22, and
 * this file must not be read as covering it.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { NormalizedEvent } from '@ccr/shared';

import { ChunkWriter, chunkFilename } from '../src/chunker.js';

const FIXTURE = fileURLToPath(new URL('../../shared/test/fixtures/events-0001.jsonl', import.meta.url));

/**
 * The events the fixture holds, in its order, with its field order.
 *
 * Field order is load-bearing: `JSON.stringify` emits an object's keys in
 * insertion order, and the fixture is that output verbatim. Reordering these
 * literals reorders the file and fails the comparison — correctly, because a
 * reordered object is different bytes, and a chunk's bytes are what the reader
 * caches by.
 */
function fixtureEvents(): NormalizedEvent[] {
  return [
    {
      seq: 0,
      ts: '2026-10-14T09:15:00.000Z',
      sessionId: 'sess-canonical',
      agentId: null,
      kind: 'user_prompt',
      // Kept as literal characters, not `\u` escapes: the writer does not escape
      // non-ASCII, so the fixture's bytes are UTF-8 and so is the CRC's input.
      text: '解释一下这个函数的作用',
    },
    {
      seq: 1,
      ts: '2026-10-14T09:15:04.000Z',
      sessionId: 'sess-canonical',
      agentId: null,
      kind: 'assistant_text',
      text: 'He said "hi"\nand left a \\ behind.',
      model: 'claude-sonnet-5',
    },
    {
      seq: 2,
      ts: '2026-10-14T09:15:09.000Z',
      sessionId: 'sess-canonical',
      agentId: null,
      kind: 'turn_end',
      turnId: 'turn-1',
      durationMs: 5000,
      messageCount: 2,
    },
  ];
}

/** First line that differs, or a length note. A raw buffer diff shows nothing. */
function describeDifference(actual: Buffer, expected: Buffer): string {
  const a = actual.toString('utf8').split('\n');
  const b = expected.toString('utf8').split('\n');

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [
        `first difference at line ${i + 1}:`,
        `  writer:  ${JSON.stringify(a[i] ?? '<absent>')}`,
        `  fixture: ${JSON.stringify(b[i] ?? '<absent>')}`,
        `(writer ${actual.length} bytes, fixture ${expected.length} bytes)`,
      ].join('\n');
    }
  }
  // Every line equal but the buffers are not: the difference is the trailing
  // newline, or a byte an encoding round-trip hid.
  return `lines match but the bytes differ (writer ${actual.length} bytes, fixture ${expected.length} bytes)`;
}

describe('ChunkWriter against the canonical fixture', () => {
  it('produces events-0001.jsonl byte-identical to the fixture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ccr-format-'));

    const writer = new ChunkWriter({ dir });
    await writer.open('sess-canonical');
    for (const event of fixtureEvents()) await writer.append(event);
    await writer.finish(); // Seal, which appends the sentinel.

    const actual = await readFile(join(dir, chunkFilename(1)));
    const expected = await readFile(FIXTURE);

    if (!actual.equals(expected)) {
      expect.fail(
        `events-0001.jsonl is not byte-identical to the canonical fixture.\n` +
          `${describeDifference(actual, expected)}\n\n` +
          'If the wire format changed on purpose, change the fixture, the phone\'s ' +
          'parser, and KNOWN-ISSUES #18 together — not this assertion.',
      );
    }

    expect(actual.equals(expected)).toBe(true);
  });

  it('mints the sentinel the fixture carries, over the chunk\'s first sequence', async () => {
    // Byte-identity above already covers this. Stated separately so that when the
    // digest is what changed, the failure names the field instead of pointing at
    // an opaque buffer comparison — this is the exact input that drifted in M8.
    const dir = await mkdtemp(join(tmpdir(), 'ccr-format-'));

    const writer = new ChunkWriter({ dir });
    await writer.open('sess-canonical');
    for (const event of fixtureEvents()) await writer.append(event);
    await writer.finish();

    const lines = (await readFile(join(dir, chunkFilename(1)), 'utf8')).trimEnd().split('\n');
    const sentinel = JSON.parse(lines.at(-1)!) as { t: string; n: number; lines: number; crc32: string };

    expect(sentinel).toEqual({ t: 'chunk_end', n: 1, lines: 3, crc32: '415383ed' });
    // Signed over the *first* event's sequence. The fixture's chunk begins at 0,
    // which is the value that used to be mistaken for "unset" — the digest was
    // then taken over sequence 1 and the reader, deriving it from the body,
    // rejected the whole chunk.
    expect(lines[0]).toContain('"seq":0');
  });
});
