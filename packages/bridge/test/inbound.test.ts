import { describe, expect, it } from 'vitest';

import {
  MAX_PROMPT_BYTES,
  parseInboundPrompt,
  signPrompt,
  signingPayload,
  verifyPrompt,
} from '../src/inbound.js';

const SECRET = 'a'.repeat(64);
const SESSION = 'sess-1';
const NOW = Date.parse('2026-10-13T10:00:00.000Z');

function makePrompt(over: Partial<{ sessionId: string; ts: string; text: string; promptId: string }> = {}) {
  const base = {
    sessionId: SESSION,
    ts: '2026-10-13T09:59:30.000Z',
    promptId: 'p-1',
    text: 'run the tests',
    ...over,
  };
  return { version: 1, ...base, sig: signPrompt(base, SECRET) };
}

const verify = (raw: unknown, over: Partial<Parameters<typeof verifyPrompt>[1]> = {}) =>
  verifyPrompt(raw, { secret: SECRET, now: NOW, ...over });

describe('signPrompt', () => {
  it('is stable for identical input', () => {
    const a = signPrompt({ sessionId: 's', ts: 't', promptId: 'p', text: 'x' }, SECRET);
    const b = signPrompt({ sessionId: 's', ts: 't', promptId: 'p', text: 'x' }, SECRET);
    expect(a).toBe(b);
  });

  it('separates fields so they cannot be shifted between positions', () => {
    // Without a delimiter these two would produce the same payload.
    const a = signingPayload({ sessionId: 'ab', ts: 'c', promptId: 'd', text: 'e' });
    const b = signingPayload({ sessionId: 'a', ts: 'bc', promptId: 'd', text: 'e' });
    expect(a).not.toBe(b);
  });

  it('changes when any signed field changes', () => {
    const base = { sessionId: 's', ts: 't', promptId: 'p', text: 'x' };
    const sig = signPrompt(base, SECRET);
    expect(signPrompt({ ...base, text: 'y' }, SECRET)).not.toBe(sig);
    expect(signPrompt({ ...base, sessionId: 'other' }, SECRET)).not.toBe(sig);
    expect(signPrompt({ ...base, ts: 't2' }, SECRET)).not.toBe(sig);
    expect(signPrompt(base, `${SECRET}b`)).not.toBe(sig);
  });
});

describe('verifyPrompt', () => {
  it('accepts a well-formed, freshly signed prompt', () => {
    const result = verify(makePrompt());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt.text).toBe('run the tests');
  });

  it('rejects a prompt whose text was edited after signing', () => {
    const prompt = makePrompt();
    const result = verify({ ...prompt, text: 'rm -rf /' });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a prompt retargeted at another session', () => {
    const prompt = makePrompt();
    const result = verify({ ...prompt, sessionId: 'someone-elses-session' });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a prompt signed with the wrong secret', () => {
    const base = { sessionId: SESSION, ts: '2026-10-13T09:59:30.000Z', promptId: 'p', text: 'x' };
    const raw = { version: 1, ...base, sig: signPrompt(base, 'not-the-secret') };
    expect(verify(raw)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses to accept anything when no secret is configured', () => {
    // Fail closed: an unconfigured bridge must not accept unsigned prompts.
    const result = verifyPrompt(makePrompt(), { secret: '', now: NOW });
    expect(result.ok).toBe(false);
  });

  describe('freshness', () => {
    it('rejects a stale prompt, bounding the value of a captured file', () => {
      const old = makePrompt({ ts: '2026-10-13T09:00:00.000Z' });
      expect(verify(old)).toEqual({ ok: false, reason: 'stale' });
    });

    it('honours a custom window', () => {
      const old = makePrompt({ ts: '2026-10-13T09:00:00.000Z' });
      expect(verify(old, { maxAgeMs: 2 * 60 * 60 * 1000 }).ok).toBe(true);
    });

    it('rejects a timestamp far in the future', () => {
      const future = makePrompt({ ts: '2027-01-01T00:00:00.000Z' });
      expect(verify(future)).toEqual({ ok: false, reason: 'future' });
    });

    it('tolerates modest clock skew between phone and PC', () => {
      const skewed = makePrompt({ ts: '2026-10-13T10:00:30.000Z' });
      expect(verify(skewed).ok).toBe(true);
    });
  });

  it('rejects a prompt aimed at a different session when one is expected', () => {
    const result = verify(makePrompt(), { expectSessionId: 'other-session' });
    expect(result).toEqual({ ok: false, reason: 'wrong-session' });
  });

  it('rejects an oversized prompt', () => {
    const result = verify(makePrompt({ text: 'x'.repeat(MAX_PROMPT_BYTES + 1) }));
    expect(result).toEqual({ ok: false, reason: 'too-long' });
  });

  it('rejects whitespace-only text', () => {
    const result = verify(makePrompt({ text: '   \n  ' }));
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a missing signature', () => {
    const { sig: _sig, ...unsigned } = makePrompt();
    expect(verify(unsigned)).toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('rejects an unsupported version', () => {
    expect(verify({ ...makePrompt(), version: 2 })).toEqual({
      ok: false,
      reason: 'unsupported-version',
    });
  });

  it('rejects malformed input rather than throwing', () => {
    for (const bad of [null, 'string', 42, [], {}, { version: 1 }]) {
      const result = verify(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('parseInboundPrompt', () => {
  it('returns null for anything missing a required field', () => {
    expect(parseInboundPrompt({ version: 1, sessionId: 's', ts: 't' })).toBeNull();
    expect(parseInboundPrompt(null)).toBeNull();
  });

  it('accepts an empty text field, leaving emptiness to the verifier', () => {
    const parsed = parseInboundPrompt({
      version: 1,
      sessionId: 's',
      ts: 't',
      promptId: 'p',
      text: '',
      sig: 'x',
    });
    expect(parsed?.text).toBe('');
  });
});
