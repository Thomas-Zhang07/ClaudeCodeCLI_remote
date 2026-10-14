import { describe, expect, it } from 'vitest';

import {
  PASTE_END,
  PASTE_START,
  injectPrompt,
  injectionRefusal,
  matchDeliveredTurn,
  splitByBytes,
  type WriteTarget,
} from '../src/inject.js';

/** Records everything written, so the framing can be asserted exactly. */
function recorder(): WriteTarget & { chunks: string[]; all: () => string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (data: string) => {
      chunks.push(data);
    },
    all: () => chunks.join(''),
  };
}

describe('matchDeliveredTurn', () => {
  const sent = (text: string) => ({ text });

  it('matches a turn that is exactly what we typed', () => {
    expect(matchDeliveredTurn([sent('run the tests')], 'run the tests')).toBe(0);
  });

  it('ignores differences in whitespace and line endings', () => {
    expect(matchDeliveredTurn([sent('run  the\ntests')], 'run the tests')).toBe(0);
  });

  it('finds the right prompt among several', () => {
    const waiting = [sent('first prompt'), sent('second prompt'), sent('third prompt')];
    expect(matchDeliveredTurn(waiting, 'second prompt')).toBe(1);
  });

  it('returns -1 when nothing matches', () => {
    expect(matchDeliveredTurn([sent('run the tests')], 'something the user typed')).toBe(-1);
  });

  it('returns -1 for an empty turn rather than matching the first entry', () => {
    // An empty turn matching everything would confirm a prompt that never arrived.
    expect(matchDeliveredTurn([sent('anything')], '   ')).toBe(-1);
  });

  it('ignores an empty entry rather than confirming it', () => {
    expect(matchDeliveredTurn([sent('')], 'a real turn')).toBe(-1);
  });

  it('matches a long prompt whose stored turn was truncated', () => {
    const body = 'Refactor the chunk reader so that '.repeat(20);
    const stored = `${body.slice(0, 400)}… [+1200 bytes]`;
    expect(matchDeliveredTurn([sent(body)], stored)).toBe(0);
  });

  it('does not match on a short shared prefix', () => {
    // "fix the bug" and "fix the build" share a prefix but are different prompts.
    expect(matchDeliveredTurn([sent('fix the bug')], 'fix the build report')).toBe(-1);
  });

  it('does not match merely because both are long', () => {
    const a = 'a'.repeat(300);
    const b = 'b'.repeat(300);
    expect(matchDeliveredTurn([sent(a)], b)).toBe(-1);
  });

  it('handles an empty waiting list', () => {
    expect(matchDeliveredTurn([], 'anything')).toBe(-1);
  });
});

describe('injectionRefusal', () => {
  const ready = {
    injectionEnabled: true,
    hasSession: true,
    controllable: true,
    lastMainKind: 'turn_end',
    isFresh: false,
  };

  it('allows a prompt when the session is idle after a completed turn', () => {
    expect(injectionRefusal(ready)).toBeNull();
  });

  describe('a freshly started session', () => {
    // Otherwise a conversation could only be continued from the phone, never
    // begun: the phone's first prompt is exactly the case with no prior turn.
    it('allows the first prompt, because nothing has run so no dialog can be open', () => {
      expect(injectionRefusal({ ...ready, lastMainKind: null, isFresh: true })).toBeNull();
    });

    it('still refuses once the session has done anything', () => {
      expect(injectionRefusal({ ...ready, lastMainKind: 'user_prompt', isFresh: false })).toBe(
        'session-not-idle',
      );
    });

    it('does not treat "we do not know" as fresh', () => {
      // A session that existed before this bridge started, with no event read
      // yet, is not fresh — it might be mid-turn.
      expect(injectionRefusal({ ...ready, lastMainKind: null, isFresh: false })).toBe(
        'session-not-idle',
      );
    });
  });

  it('refuses while the operator has injection switched off', () => {
    expect(injectionRefusal({ ...ready, injectionEnabled: false })).toBe('injection-disabled');
  });

  it('refuses a session the bridge does not know', () => {
    expect(injectionRefusal({ ...ready, hasSession: false })).toBe('unknown-session');
  });

  it('refuses a session no ccr process owns', () => {
    expect(injectionRefusal({ ...ready, controllable: false })).toBe('not-controllable');
  });

  describe('the mid-turn guard', () => {
    // A permission dialog only exists mid-turn, so anything other than a
    // completed turn might be a dialog — and typing into a dialog answers it,
    // which can approve a tool rather than submit a prompt.
    it.each([
      'assistant_text',
      'tool_call',
      'turn_start',
      'user_prompt',
      'attention',
    ])('refuses while the last main-thread event is %s', (kind) => {
      expect(injectionRefusal({ ...ready, lastMainKind: kind })).toBe('session-not-idle');
    });

    it('refuses a session that has produced no main-thread events at all', () => {
      expect(injectionRefusal({ ...ready, lastMainKind: null })).toBe('session-not-idle');
    });

    it('fails closed on a status it does not recognise', () => {
      expect(injectionRefusal({ ...ready, lastMainKind: 'something-new' })).toBe('session-not-idle');
    });
  });

  it('checks the policy before anything else, so a disabled bridge never types', () => {
    // Even a session that would otherwise be rejected outright is reported as
    // disabled, because that is the reason the operator can act on.
    expect(
      injectionRefusal({
        injectionEnabled: false,
        hasSession: false,
        controllable: false,
        lastMainKind: null,
      }),
    ).toBe('injection-disabled');
  });
});

describe('splitByBytes', () => {
  it('returns the whole string when it fits', () => {
    expect(splitByBytes('hello', 100)).toEqual(['hello']);
  });

  it('returns nothing for an empty string', () => {
    expect(splitByBytes('', 10)).toEqual([]);
  });

  it('splits on the byte budget', () => {
    const out = splitByBytes('a'.repeat(25), 10);
    expect(out).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
  });

  it('never splits a multi-byte character', () => {
    // "中" is 3 bytes, so a 10-byte budget holds three of them.
    const out = splitByBytes('中'.repeat(10), 10);
    expect(out.join('')).toBe('中'.repeat(10));
    for (const chunk of out) {
      expect(chunk).not.toContain('�');
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(10);
      expect(chunk).toMatch(/^中*$/);
    }
  });

  it('reassembles exactly', () => {
    const text = 'mixed 中文 and ascii and more 中文字符 tail';
    expect(splitByBytes(text, 7).join('')).toBe(text);
  });

  it('rejects a non-positive budget rather than looping forever', () => {
    expect(() => splitByBytes('abc', 0)).toThrow();
  });
});

describe('injectPrompt', () => {
  it('wraps the text in paste markers, which is what stops the TUI collapsing it', async () => {
    const target = recorder();
    await injectPrompt(target, 'hello', { chunkDelayMs: 0, settleMs: 0 });

    expect(target.all()).toBe(`${PASTE_START}hello${PASTE_END}\r`);
  });

  it('sends Enter last, and as a carriage return', async () => {
    const target = recorder();
    await injectPrompt(target, 'hello', { chunkDelayMs: 0, settleMs: 0 });

    expect(target.chunks.at(-1)).toBe('\r');
    // A bare newline would be a newline inside the prompt, not a submit.
    expect(target.all().endsWith('\n')).toBe(false);
  });

  it('opens and closes the paste exactly once', async () => {
    const target = recorder();
    await injectPrompt(target, 'a'.repeat(5000), { chunkDelayMs: 0, settleMs: 0 });

    const all = target.all();
    expect(all.split(PASTE_START)).toHaveLength(2);
    expect(all.split(PASTE_END)).toHaveLength(2);
  });

  describe('line endings', () => {
    it('normalises CRLF so a stray return cannot submit early', async () => {
      const target = recorder();
      await injectPrompt(target, 'first\r\nsecond', { chunkDelayMs: 0, settleMs: 0 });

      const body = target.all().slice(PASTE_START.length, -PASTE_END.length - 1);
      expect(body).toBe('first\nsecond');
      expect(body).not.toContain('\r');
    });

    it('keeps multi-line prompts as one submission', async () => {
      const target = recorder();
      await injectPrompt(target, 'line one\nline two\nline three', {
        chunkDelayMs: 0,
        settleMs: 0,
      });

      const all = target.all();
      expect(all.indexOf(PASTE_END)).toBeLessThan(all.lastIndexOf('\r'));
      expect(all.split('\r')).toHaveLength(2);
    });
  });

  describe('chunking', () => {
    it('chunks a large prompt rather than writing it in one burst', async () => {
      const target = recorder();
      await injectPrompt(target, 'x'.repeat(2000), {
        chunkBytes: 256,
        chunkDelayMs: 0,
        settleMs: 0,
      });

      // markers + body chunks + enter
      expect(target.chunks.length).toBeGreaterThan(4);
      for (const chunk of target.chunks.slice(1, -1)) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(256);
      }
    });

    it('preserves a CJK prompt exactly through chunking', async () => {
      const target = recorder();
      const text = '请帮我修复这个构建错误，谢谢'.repeat(20);
      await injectPrompt(target, text, { chunkBytes: 32, chunkDelayMs: 0, settleMs: 0 });

      const all = target.all();
      const body = all.slice(PASTE_START.length, all.length - PASTE_END.length - 1);
      expect(body).toBe(text);
      expect(all).not.toContain('�');
    });
  });

  it('waits for the paste to settle before pressing Enter', async () => {
    const target = recorder();
    const marks: number[] = [];
    const timed: WriteTarget = {
      write: (data: string) => {
        target.write(data);
        if (data === PASTE_END) marks.push(Date.now());
        if (data === '\r') marks.push(Date.now());
      },
    };

    await injectPrompt(timed, 'hello', { chunkDelayMs: 0, settleMs: 40 });

    expect(marks).toHaveLength(2);
    expect(marks[1]! - marks[0]!).toBeGreaterThanOrEqual(30);
  });
});
