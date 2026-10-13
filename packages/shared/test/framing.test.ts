import { describe, expect, it } from 'vitest';
import { LineFramer } from '../src/framing.js';

const nl = (s: string): Buffer => Buffer.from(s + '\n', 'utf8');

describe('LineFramer', () => {
  it('returns complete lines and buffers the remainder', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\n{"b"', 'utf8'))).toEqual(['{"a":1}']);
    expect(f.hasPartial).toBe(true);
    expect(f.push(Buffer.from(':2}\n', 'utf8'))).toEqual(['{"b":2}']);
    expect(f.hasPartial).toBe(false);
  });

  it('does not emit a line that has no terminator', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}', 'utf8'))).toEqual([]);
  });

  it('strips CRLF terminators', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('{"a":1}\r\n', 'utf8'))).toEqual(['{"a":1}']);
  });

  it('skips blank and whitespace-only lines', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('\n\n   \n{"a":1}\n', 'utf8'))).toEqual(['{"a":1}']);
  });

  it('strips leading NUL padding, which the harness also tolerates', () => {
    const f = new LineFramer();
    expect(f.push(Buffer.from('\u0000\u0000{"a":1}\n', 'utf8'))).toEqual(['{"a":1}']);
  });

  describe('multi-byte characters split across reads', () => {
    // "中文" is 6 bytes. Cutting it at 4 leaves a partial character in the buffer.
    const line = Buffer.from('{"t":"中文"}\n', 'utf8');

    it('reassembles rather than emitting a replacement glyph', () => {
      const f = new LineFramer();
      const first = f.push(line.subarray(0, 9));
      const second = f.push(line.subarray(9));

      expect(first).toEqual([]);
      expect(second).toEqual(['{"t":"中文"}']);
      expect([...first, ...second].join('')).not.toContain('�');
    });

    it('handles a byte-at-a-time reader', () => {
      const f = new LineFramer();
      const out: string[] = [];
      for (const byte of line) out.push(...f.push(Buffer.from([byte])));

      expect(out).toEqual(['{"t":"中文"}']);
      expect(out.join('')).not.toContain('�');
    });
  });

  describe('oversized lines', () => {
    it('discards a line past the cap and resynchronises at the next newline', () => {
      const f = new LineFramer({ maxLineBytes: 32 });
      f.push(Buffer.from('x'.repeat(64), 'utf8'));
      expect(f.stats.droppedLines).toBe(1);

      // The tail of the dropped line, then a good line.
      const out = f.push(Buffer.from('tail\n{"ok":true}\n', 'utf8'));
      expect(out).toEqual(['{"ok":true}']);
    });
  });

  describe('pendingPreview', () => {
    it('drops a trailing partial character instead of showing a replacement glyph', () => {
      const f = new LineFramer();
      const full = Buffer.from('{"t":"中文"}', 'utf8');
      f.push(full.subarray(0, full.length - 2)); // cuts the final character

      const preview = f.pendingPreview();
      expect(preview).not.toContain('�');
      expect(preview.startsWith('{"t":"中')).toBe(true);
    });

    it('returns the whole partial line when it is complete', () => {
      const f = new LineFramer();
      f.push(Buffer.from('{"t":"abc"}', 'utf8'));
      expect(f.pendingPreview()).toBe('{"t":"abc"}');
    });

    it('returns empty when nothing is buffered', () => {
      expect(new LineFramer().pendingPreview()).toBe('');
    });
  });

  it('reset() discards partial state after a file is rotated', () => {
    const f = new LineFramer();
    f.push(Buffer.from('{"partial":', 'utf8'));
    f.reset();
    expect(f.hasPartial).toBe(false);
    expect(f.push(nl('{"fresh":1}'))).toEqual(['{"fresh":1}']);
  });
});
