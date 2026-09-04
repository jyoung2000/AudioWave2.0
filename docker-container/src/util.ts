import { createHash, createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import { toBase64Url } from '@now-playing/domain';
import type { Clock, RandomSource } from './deps.js';

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowIsoFrom(clock: Clock): string {
  return iso(clock.now());
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: Uint8Array, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time comparison of two strings (length differences also take constant time relative to the longer input). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    nodeTimingSafeEqual(ba, ba);
    return false;
  }
  return nodeTimingSafeEqual(ba, bb);
}

export function randomToken(random: RandomSource, bytes = 32): string {
  return toBase64Url(random.bytes(bytes));
}

export function randomId(random: RandomSource): string {
  return toBase64Url(random.bytes(16));
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function parseJson<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Opaque, URL-safe pagination cursor over a small JSON payload. */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | undefined | null): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function bool(value: unknown): 0 | 1 {
  return value ? 1 : 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Escape text for inclusion in HTML text nodes and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function backoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp * (0.5 + random() * 0.5));
}
