/**
 * Prompt signing.
 *
 * The PC verifies every inbound prompt independently of repository permissions,
 * because write access to the relay repository is effectively shell access to
 * that machine. The signature covers session, timestamp, id and text, so a
 * captured prompt cannot be retargeted, replayed or edited.
 */

import { bytesToHex, utf8Bytes } from './encoding';

export interface SignablePrompt {
  sessionId: string;
  ts: string;
  promptId: string;
  text: string;
}

/**
 * The exact bytes that get signed. Newline-separated so no field can be shifted
 * into another's position. Must match `signingPayload` in the bridge.
 */
export function signingPayload(input: SignablePrompt): string {
  return [input.sessionId, input.ts, input.promptId, input.text].join('\n');
}

export class CryptoUnavailableError extends Error {
  override readonly name = 'CryptoUnavailableError';
  constructor() {
    super(
      'Web Crypto is unavailable on this page, so prompts cannot be signed. ' +
        'Open the app over https:// (or localhost) — browsers only expose crypto.subtle on secure origins.',
    );
  }
}

export function webCryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function';
}

export async function signPrompt(input: SignablePrompt, secret: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.importKey !== 'function') throw new CryptoUnavailableError();

  const key = await subtle.importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await subtle.sign('HMAC', key, utf8Bytes(signingPayload(input)));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * A UUID for the prompt id.
 *
 * `randomUUID` needs a secure context too, so there is a fallback: the id only
 * has to be unique, and it is covered by the signature either way.
 */
export function newPromptId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') {
    try {
      return uuid.call(globalThis.crypto);
    } catch {
      // Fall through to the manual path.
    }
  }

  const bytes = new Uint8Array(16);
  const random = globalThis.crypto?.getRandomValues;
  if (typeof random === 'function') {
    random.call(globalThis.crypto, bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A short random suffix for the inbound filename. */
export function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  const random = globalThis.crypto?.getRandomValues;
  if (typeof random === 'function') random.call(globalThis.crypto, bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytesToHex(bytes);
}
