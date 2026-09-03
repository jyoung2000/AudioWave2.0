import type { PairingLinkPayload } from '@now-playing/contracts';
import { crockfordEncode, crockfordIsValid, crockfordNormalize, fromBase64Url, randomBytes, sha256Hex, timingSafeEqual, toBase64Url } from './ids.js';

/** 10 Crockford characters = 50 bits of entropy. Displayed as XXXXX-XXXXX. */
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_CODE_BITS = PAIRING_CODE_LENGTH * 5;
export const PAIRING_DEFAULT_TTL_SECONDS = 600;
export const PAIRING_MAX_ATTEMPTS = 5;

export function generatePairingCode(): string {
  // 7 random bytes = 56 bits -> 12 chars; keep 10 chars (50 bits)
  return crockfordEncode(randomBytes(7)).slice(0, PAIRING_CODE_LENGTH);
}

export function formatPairingCode(code: string): string {
  const n = crockfordNormalize(code);
  return `${n.slice(0, 5)}-${n.slice(5, 10)}`;
}

export function normalizePairingCode(input: string): string | null {
  const n = crockfordNormalize(input);
  if (n.length !== PAIRING_CODE_LENGTH || !crockfordIsValid(n)) return null;
  return n;
}

/** Only a salted hash of the code is persisted; the hub id acts as the salt so hashes are not portable between hubs. */
export async function hashPairingCode(code: string, hubId: string): Promise<string> {
  return sha256Hex(`pairing-code:v1:${hubId}:${crockfordNormalize(code)}`);
}

export async function verifyPairingCode(code: string, hubId: string, storedHash: string): Promise<boolean> {
  const normalized = normalizePairingCode(code);
  if (!normalized) return false;
  return timingSafeEqual(await hashPairingCode(normalized, hubId), storedHash);
}

export function isExpired(expiresAt: string, now: number = Date.now()): boolean {
  return Date.parse(expiresAt) <= now;
}

/** Short human-comparable fingerprint of two public keys (order-independent). Shown on both devices. */
export async function verificationFingerprint(hubPublicKey: string, devicePublicKey: string, sessionId: string): Promise<string> {
  const material = [hubPublicKey, devicePublicKey].sort().join('|') + '|' + sessionId;
  const hex = await sha256Hex(`verify:v1:${material}`);
  return formatFingerprint(hex.slice(0, 12));
}

/** Format a hex string as grouped upper-case quads: "AB12-CD34-EF56". */
export function formatFingerprint(hex: string): string {
  const up = hex.toUpperCase();
  return up.match(/.{1,4}/g)?.join('-') ?? up;
}

/** Fingerprint of a public key (first 32 hex chars of SHA-256, grouped). */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const hex = await sha256Hex(`pk:v1:${publicKey}`);
  return formatFingerprint(hex.slice(0, 32));
}

export function encodePairingLink(payload: PairingLinkPayload, scheme = 'nowplaying'): string {
  const json = JSON.stringify(payload);
  return `${scheme}://pair#${toBase64Url(new TextEncoder().encode(json))}`;
}

export function decodePairingLink(link: string): PairingLinkPayload | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/pair#([A-Za-z0-9_-]+)$/.exec(link.trim());
  if (!m) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(fromBase64Url(m[1]!))) as PairingLinkPayload;
    if (json.v !== 1 || typeof json.code !== 'string' || typeof json.endpoint !== 'string' || typeof json.fp !== 'string' || typeof json.hubId !== 'string') return null;
    return json;
  } catch {
    return null;
  }
}

/** Pure token bucket used for pairing/login rate limits. */
export interface TokenBucketState {
  tokens: number;
  updatedAt: number;
}

export function takeToken(state: TokenBucketState | undefined, options: { capacity: number; refillPerSecond: number; now: number }): { allowed: boolean; state: TokenBucketState; retryAfterSeconds: number } {
  const current = state ?? { tokens: options.capacity, updatedAt: options.now };
  const elapsed = Math.max(0, (options.now - current.updatedAt) / 1000);
  const tokens = Math.min(options.capacity, current.tokens + elapsed * options.refillPerSecond);
  if (tokens >= 1) return { allowed: true, state: { tokens: tokens - 1, updatedAt: options.now }, retryAfterSeconds: 0 };
  const retryAfterSeconds = Math.ceil((1 - tokens) / options.refillPerSecond);
  return { allowed: false, state: { tokens, updatedAt: options.now }, retryAfterSeconds };
}

/** Generate a device credential secret: 32 random bytes, base64url. */
export function generateCredentialSecret(): string {
  return toBase64Url(randomBytes(32));
}

export async function hashCredentialSecret(secret: string, credentialId: string): Promise<string> {
  return sha256Hex(`cred:v1:${credentialId}:${secret}`);
}

export function generateInviteCode(): string {
  return crockfordEncode(randomBytes(5)).slice(0, 8);
}
