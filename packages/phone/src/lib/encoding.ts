/**
 * Base64 and hashing helpers.
 *
 * Gitee's contents API hands back base64 and expects base64. Going through
 * `atob`/`btoa` on the raw string mangles anything non-Latin-1, so every path
 * here is bytes-first: text -> TextEncoder -> bytes -> base64, and back through
 * TextDecoder. The reference project does the same thing for the same reason.
 */

/** Applied in slices: `String.fromCharCode(...bytes)` overflows the stack on big inputs. */
const SLICE = 0x8000;

/**
 * Bytes backed by a plain ArrayBuffer.
 *
 * TypeScript 5.7 made `Uint8Array` generic over its buffer, and Web Crypto only
 * accepts the non-shared flavour — spelling it out keeps `subtle.*` calls
 * type-safe without a cast.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function base64ToBytes(base64: string): Bytes {
  // Gitee wraps long content with newlines; `atob` rejects the whitespace.
  const cleaned = base64.replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

export function decodeBase64Text(base64: string): string {
  // Decoding the bytes with TextDecoder is what keeps CJK intact.
  return new TextDecoder('utf-8').decode(base64ToBytes(base64));
}

export function encodeBase64Text(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function utf8Bytes(text: string): Bytes {
  return new TextEncoder().encode(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Web Crypto is only exposed on secure origins (https, or localhost). */
export function cryptoAvailable(): boolean {
  return typeof globalThis.crypto?.subtle?.digest === 'function';
}

export async function sha256Hex(data: Bytes | string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data;
  const digest = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// CRC-32 (matches the bridge's sentinel checksum)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
