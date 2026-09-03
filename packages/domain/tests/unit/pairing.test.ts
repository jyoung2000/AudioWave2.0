import { describe, expect, it } from 'vitest';
import { decodePairingLink, encodePairingLink, formatPairingCode, generatePairingCode, hashPairingCode, isExpired, normalizePairingCode, takeToken, verificationFingerprint, verifyPairingCode } from '../../src/pairing.js';

describe('pairing', () => {
  it('generates 50-bit Crockford codes', () => {
    const codes = new Set(Array.from({ length: 200 }, generatePairingCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(formatPairingCode('ABCDE12345')).toBe('ABCDE-12345');
  });
  it('normalizes and verifies against a salted hash', async () => {
    const code = generatePairingCode();
    const hash = await hashPairingCode(code, 'hub-1');
    expect(await verifyPairingCode(formatPairingCode(code).toLowerCase(), 'hub-1', hash)).toBe(true);
    expect(await verifyPairingCode(code, 'hub-2', hash)).toBe(false);
    expect(normalizePairingCode('too-short')).toBeNull();
    expect(normalizePairingCode('ABCDE-1234U')).toBeNull();
  });
  it('expiry and token bucket', () => {
    expect(isExpired('2020-01-01T00:00:00.000Z')).toBe(true);
    let state = undefined as ReturnType<typeof takeToken>['state'] | undefined;
    const results: boolean[] = [];
    for (let i = 0; i < 7; i += 1) {
      const r = takeToken(state, { capacity: 5, refillPerSecond: 1 / 60, now: 1_000_000 });
      state = r.state;
      results.push(r.allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false, false]);
    const later = takeToken(state, { capacity: 5, refillPerSecond: 1 / 60, now: 1_000_000 + 61_000 });
    expect(later.allowed).toBe(true);
  });
  it('encodes and decodes links; fingerprints are symmetric', async () => {
    const payload = { v: 1 as const, code: 'ABCDE12345', endpoint: 'https://hub.example', hubId: '0192b1f0-0000-7000-8000-000000000001', fp: 'AB12-CD34', exp: 1_800_000_000 };
    expect(decodePairingLink(encodePairingLink(payload))).toEqual(payload);
    expect(decodePairingLink('nowplaying://pair#!!!')).toBeNull();
    expect(await verificationFingerprint('A', 'B', 's')).toBe(await verificationFingerprint('B', 'A', 's'));
  });
});
