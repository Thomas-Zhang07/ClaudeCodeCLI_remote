/**
 * Prompts arriving from the phone.
 *
 * This is the security boundary. A prompt that gets through is injected into an
 * agent with shell access, so write access to the relay repository is
 * effectively write access to this machine. Repo permissions are not a
 * sufficient authorisation boundary on their own — they are an access list
 * enforced by a third party — so every prompt is authenticated independently.
 *
 * Signature covers the session, timestamp, id, and text, which means a captured
 * prompt cannot be retargeted at another session, replayed, or edited.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { InboundPrompt } from '@ccr/shared';

/** Maximum text length accepted from the phone. */
export const MAX_PROMPT_BYTES = 8_000;

/** Prompts older than this are refused, bounding the value of a captured file. */
export const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export function signingPayload(input: {
  sessionId: string;
  ts: string;
  promptId: string;
  text: string;
}): string {
  // Newline-separated so no field can be shifted into another's position.
  return [input.sessionId, input.ts, input.promptId, input.text].join('\n');
}

export function signPrompt(
  input: { sessionId: string; ts: string; promptId: string; text: string },
  secret: string,
): string {
  return createHmac('sha256', secret).update(signingPayload(input), 'utf8').digest('hex');
}

export type VerifyResult =
  | { ok: true; prompt: InboundPrompt }
  | { ok: false; reason: VerifyFailure };

export type VerifyFailure =
  | 'malformed'
  | 'unsupported-version'
  | 'missing-signature'
  | 'bad-signature'
  | 'stale'
  | 'future'
  | 'too-long'
  | 'wrong-session'
  | 'empty';

export function parseInboundPrompt(raw: unknown): InboundPrompt | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const sessionId = str(o['sessionId']);
  const promptId = str(o['promptId']);
  const ts = str(o['ts']);
  const text = typeof o['text'] === 'string' ? o['text'] : null;
  const sig = typeof o['sig'] === 'string' ? o['sig'] : '';
  const version = o['version'];

  if (!sessionId || !promptId || !ts || text === null) return null;

  return {
    version: version === 1 ? 1 : 1,
    sessionId,
    promptId,
    ts,
    text,
    sig,
  };
}

export interface VerifyOptions {
  secret: string;
  /** When set, the prompt must target this session. */
  expectSessionId?: string;
  maxAgeMs?: number;
  now?: number;
}

export function verifyPrompt(raw: unknown, options: VerifyOptions): VerifyResult {
  if (options.secret.length === 0) return { ok: false, reason: 'bad-signature' };

  const prompt = parseInboundPrompt(raw);
  if (!prompt) return { ok: false, reason: 'malformed' };

  if ((raw as Record<string, unknown>)['version'] !== 1) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (prompt.sig.length === 0) return { ok: false, reason: 'missing-signature' };
  if (prompt.text.trim().length === 0) return { ok: false, reason: 'empty' };

  if (Buffer.byteLength(prompt.text, 'utf8') > MAX_PROMPT_BYTES) {
    return { ok: false, reason: 'too-long' };
  }

  if (options.expectSessionId && prompt.sessionId !== options.expectSessionId) {
    return { ok: false, reason: 'wrong-session' };
  }

  const expected = signPrompt(prompt, options.secret);
  if (!constantTimeEqual(expected, prompt.sig)) return { ok: false, reason: 'bad-signature' };

  const issued = Date.parse(prompt.ts);
  if (!Number.isFinite(issued)) return { ok: false, reason: 'malformed' };

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (now - issued > maxAge) return { ok: false, reason: 'stale' };
  // A little clock skew between phone and PC is normal; a large forward jump is
  // not, and would let a captured prompt outlive the freshness window.
  if (issued - now > 60_000) return { ok: false, reason: 'future' };

  return { ok: true, prompt };
}

/**
 * Compare two signatures without leaking where they diverge.
 *
 * Length is compared first because `timingSafeEqual` throws on a mismatch, and
 * the signature length is fixed and public anyway.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
