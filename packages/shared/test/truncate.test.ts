import { describe, expect, it } from 'vitest';
import { clipProse, clipShort, singleLine, truncateText } from '../src/truncate.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('truncateText', () => {
  it('returns short input untouched', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('honours an ASCII byte ceiling and marks what it dropped', () => {
    const out = truncateText('a'.repeat(1000), 100);
    expect(bytes(out)).toBeLessThanOrEqual(100);
    expect(out).toContain('[+');
  });

  it('counts CJK in bytes, not characters', () => {
    // 300 Chinese characters is 900 UTF-8 bytes, so a 100-byte budget must cut it
    // to roughly a tenth — the point of budgeting in bytes at all.
    const out = truncateText('中'.repeat(300), 100);
    expect(bytes(out)).toBeLessThanOrEqual(100);
    expect(out.length).toBeLessThan(40);
  });

  it('never splits a multi-byte character', () => {
    const out = truncateText('中'.repeat(300), 101);
    expect(out).not.toContain('�');
    // Every retained character must still be a whole one.
    expect(out.replace(/… \[\+\d+ bytes\]$/, '')).toMatch(/^中*$/);
  });

  it('keeps within budget for a budget smaller than the marker itself', () => {
    const out = truncateText('abcdefghij', 8);
    expect(bytes(out)).toBeLessThanOrEqual(8);
  });

  it('handles an empty string', () => {
    expect(truncateText('', 10)).toBe('');
  });
});

describe('singleLine', () => {
  it('collapses newlines and runs of whitespace', () => {
    expect(singleLine('a\n\n  b\t\tc  ')).toBe('a b c');
  });
});

describe('clipShort', () => {
  it('collapses then truncates', () => {
    const out = clipShort('line one\nline two\nline three', 12);
    expect(out).not.toContain('\n');
    expect(bytes(out)).toBeLessThanOrEqual(12);
  });
});

describe('clipProse', () => {
  it('preserves newlines so code blocks and lists stay readable on a phone', () => {
    const text = 'Here is the plan:\n\n1. one\n2. two\n\n```js\nconst a = 1;\n```';
    expect(clipProse(text, 10_000)).toBe(text);
  });
});
