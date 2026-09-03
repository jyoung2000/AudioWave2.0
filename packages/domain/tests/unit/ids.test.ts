import { describe, expect, it } from 'vitest';
import { crockfordEncode, crockfordNormalize, fnv1a, isUuid, seededShuffle, sha256Hex, timingSafeEqual, uuidv7, uuidv7Time } from '../../src/ids.js';

describe('uuidv7', () => {
  it('produces valid, monotonic ids', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    for (const id of ids) expect(isUuid(id)).toBe(true);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('embeds the timestamp', () => {
    const t = Date.UTC(2026, 8, 3, 12, 0, 0);
    const id = uuidv7(t);
    expect(uuidv7Time(id)).toBe(t);
  });
});

describe('crockford', () => {
  it('normalizes confusable characters', () => {
    expect(crockfordNormalize('oi1l-abc')).toBe('0111ABC');
    expect(crockfordEncode(new Uint8Array([0, 0, 0]))).toBe('00000');
  });
});

describe('hashing', () => {
  it('sha256 matches known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('timingSafeEqual', () => {
    expect(timingSafeEqual('a', 'a')).toBe(true);
    expect(timingSafeEqual('a', 'b')).toBe(false);
    expect(timingSafeEqual('a', 'ab')).toBe(false);
  });
  it('seeded shuffle is deterministic', () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6], 42);
    const b = seededShuffle([1, 2, 3, 4, 5, 6], 42);
    expect(a).toEqual(b);
    expect(fnv1a('now playing')).toBe(fnv1a('now playing'));
  });
});
