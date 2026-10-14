/**
 * The chunk wire format, pinned to one byte sequence.
 *
 * **Why this file exists.** The format is implemented twice, in two languages:
 * `packages/bridge/src/chunker.ts` writes the terminating
 * `{"t":"chunk_end",…}` sentinel, and `packages/phone/src/lib/events.ts` parses
 * it. Nothing forced those two to agree. They once disagreed: the checksum's
 * input was changed in M8 on one side only, so *every* chunk failed validation
 * and the phone showed nothing at all. It was caught by reading the code, not by
 * a test — because there was no artefact either side was measured against.
 *
 * `test/fixtures/events-0001.jsonl` is now that artefact: a complete, sealed
 * chunk file, byte for byte as it appears on disk. The writer is asserted against
 * it in `packages/bridge/test/chunk-format.test.ts`. This file checks the fixture
 * *internally* — that it is well-formed, self-consistent, and that its digest is
 * the one the format specifies — so the fixture cannot quietly rot into something
 * no writer would ever produce.
 *
 * **What is deliberately NOT pinned here.** The phone's parser. `packages/phone`
 * is not a workspace, has no test runner and resolves its imports through `@/*`
 * aliases, so neither this package nor vitest can load it (KNOWN-ISSUES #22).
 * The reader is still agreement by convention; see KNOWN-ISSUES #18.
 *
 * **If you are here because a test moved.** The fixture is the canonical
 * definition, not a snapshot of whatever the writer currently does. Regenerating
 * it to make a failure go away deletes the only protection this bug ever had.
 * Change the fixture only when the *format* changes on purpose, and then change
 * both sides and the phone with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { ChunkEndSentinel, NormalizedEvent } from '../src/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/events-0001.jsonl', import.meta.url));

/**
 * CRC-32, written out here rather than imported.
 *
 * Deliberately independent of the bridge's copy in `chunker.ts`: a test that
 * reuses the implementation under test can only prove it agrees with itself.
 * (@ccr/shared has no CRC helper to reuse in any case — the sentinel's digest is
 * the only place the format calls for one.)
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** Hex, zero-padded to 8 — the width the writer's `crc32()` emits. */
function crc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

const fixtureBytes = readFileSync(FIXTURE);
const fixtureText = fixtureBytes.toString('utf8');

/**
 * The file's lines, with the terminator's trailing empty string removed.
 *
 * Reading it as bytes-then-text on purpose: the fixture's encoding is part of
 * the format. The writer emits UTF-8 with LF endings, so a fixture that had
 * acquired CRLF or a UTF-8 BOM would no longer describe what a writer produces —
 * and the CRC covers UTF-8 bytes, so a mis-encoded fixture would disagree with
 * its own digest.
 */
const lines = (() => {
  const split = fixtureText.split('\n');
  return split.at(-1) === '' ? split.slice(0, -1) : split;
})();

const sentinelLine = lines.at(-1) ?? '';
const eventLines = lines.slice(0, -1);

const sentinel = JSON.parse(sentinelLine) as ChunkEndSentinel;
const firstSeq = (JSON.parse(eventLines[0] ?? '{}') as NormalizedEvent).seq;

describe('the canonical chunk fixture', () => {
  it('is UTF-8 with LF endings and one trailing newline', () => {
    expect(fixtureText).not.toContain('\r');
    expect(fixtureBytes[0]).not.toBe(0xef); // No BOM.
    expect(fixtureText.endsWith('\n')).toBe(true);
    // Every line terminated, none blank: the writer writes one JSON object plus
    // `\n` per event and never emits a blank line.
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).not.toBe('');
  });

  it('holds events followed by the sentinel, with nothing after it', () => {
    // "Sentinel last" is the whole basis of the seal: its presence is how the
    // reader knows the chunk is complete, and anything after it would mean the
    // sentinel did not terminate the file.
    for (const line of eventLines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(event.t).toBeUndefined();
      expect(typeof event.seq).toBe('number');
      expect(typeof event.kind).toBe('string');
    }

    expect(sentinel.t).toBe('chunk_end');
    expect(sentinel.n).toBe(1);
    expect(lines.at(-1)).toBe(sentinelLine);
  });

  it('signs the chunk with `lines` equal to the number of events it holds', () => {
    // The strong check in practice: it is derivable from the chunk alone, and it
    // is what catches a truncated or duplicated body. The CRC below is weaker,
    // because the reader can derive its input from the same body.
    expect(sentinel.lines).toBe(eventLines.length);
    expect(eventLines).toHaveLength(3);
  });

  it('carries a CRC-32 over `<firstSeq>:<lines>` in UTF-8', () => {
    // The contract exactly as both sides implement it. `firstSeq` comes from the
    // first event line, not from the sentinel — that is what makes the digest a
    // check of the body rather than of itself.
    const expected = crc32(Buffer.from(`${firstSeq}:${sentinel.lines}`, 'utf8'));
    expect(sentinel.crc32).toBe(expected);

    // The reader derives the first sequence from the body, so a digest signed
    // over anything else fails everywhere. This pins the specific case that was
    // once wrong: the writer used 0 as its "no first event yet" marker, but 0 is
    // a real sequence, so the digest came out signed over the *second* event's
    // sequence and every chunk beginning at sequence 0 was rejected whole.
    expect(firstSeq).toBe(0);
    expect(crc32(Buffer.from(`1:${sentinel.lines}`, 'utf8'))).not.toBe(sentinel.crc32);
  });

  it('is pinned by digest, so it cannot be regenerated to silence a failure', () => {
    // The literal is what makes the fixture canonical rather than a snapshot.
    // If it fails, the fixture changed — decide whether the *format* changed,
    // and if it did, change the phone too before touching this number.
    expect(sentinel.crc32).toBe('415383ed');
    expect(fixtureBytes.length).toBe(543);
  });

  it('still exercises the bytes a naive implementation gets wrong', () => {
    // The fixture earns its place by holding the hard cases. A regenerated
    // fixture of ASCII-only events would still pass every check above while
    // testing nothing, so the content is asserted too.
    const [, assistantLine] = eventLines;
    const assistant = JSON.parse(assistantLine ?? '{}') as { text?: string };

    // A multi-byte character, kept literal by `JSON.stringify` rather than
    // escaped: the file must be UTF-8, and the CRC is over those bytes.
    expect(eventLines[0]).toContain('解释一下这个函数的作用');

    // A quote, a newline and a backslash, each escaped — a `text` field is free
    // text from a transcript and will contain all three.
    expect(assistantLine).toContain('\\"hi\\"');
    expect(assistantLine).toContain('\\n');
    expect(assistantLine).toContain('\\\\');
    expect(assistant.text).toBe('He said "hi"\nand left a \\ behind.');
  });

  it('is serialized the way the writer serializes: compact, keys in insertion order', () => {
    // No pretty-printing and no space after `:`. It matters because the sentinel
    // is *appended* to a file whose earlier lines are already published: a
    // re-serialization with different whitespace would change the bytes of a
    // chunk the reader has cached.
    for (const line of lines) {
      expect(JSON.stringify(JSON.parse(line))).toBe(line);
    }
  });
});
