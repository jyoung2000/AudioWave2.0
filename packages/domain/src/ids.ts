/** UUIDv7 generation and Crockford Base32 helpers. Works in browsers, Node and Electron (Web Crypto). */

const cryptoImpl: Crypto = globalThis.crypto;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  cryptoImpl.getRandomValues(out);
  return out;
}

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 UUID version 7: 48-bit unix ms timestamp, 12-bit monotonic sequence, 62 random bits.
 * Ids generated on one device are time-ordered and remain stable across sync.
 */
export function uuidv7(explicitNow?: number): string {
  let ms = Math.max(0, Math.floor(explicitNow ?? Date.now()));
  if (explicitNow !== undefined) {
    // explicit timestamps (fixtures, imports) do not participate in the monotonic guard
    seq = randomBytes(2)[0]! & 0x0fff;
  } else if (ms === lastMs) {
    seq = (seq + 1) & 0x0fff;
    if (seq === 0) ms += 1;
  } else if (ms > lastMs) {
    seq = randomBytes(2)[0]! & 0x0fff;
  } else {
    // clock went backwards: keep monotonic ordering
    ms = lastMs;
    seq = (seq + 1) & 0x0fff;
  }
  if (explicitNow === undefined) lastMs = ms;
  const rnd = randomBytes(8);
  const bytes = new Uint8Array(16);
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (rnd[0]! & 0x3f);
  for (let i = 9; i < 16; i += 1) bytes[i] = rnd[i - 8]!;
  return formatUuid(bytes);
}

export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Extract the millisecond timestamp embedded in a UUIDv7. */
export function uuidv7Time(id: string): number | null {
  if (!isUuid(id) || id[14] !== '7') return null;
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number.parseInt(hex, 16);
}

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockfordEncode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Normalize human input: uppercase, drop separators, map easily confused characters. */
export function crockfordNormalize(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function crockfordIsValid(input: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]+$/.test(input);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  // Copy into a plain ArrayBuffer: Node's and the DOM's `BufferSource` differ once a Uint8Array
  // can be backed by a SharedArrayBuffer, and the copy satisfies both without a cast.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await cryptoImpl.subtle.digest('SHA-256', buffer);
  return toHex(new Uint8Array(digest));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i += 1) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Deterministic PRNG (mulberry32) for reproducible shuffles and fixtures. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rnd = seededRandom(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Stable 32-bit FNV-1a hash of a string (for shuffle seeds and cache keys, not security). */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
