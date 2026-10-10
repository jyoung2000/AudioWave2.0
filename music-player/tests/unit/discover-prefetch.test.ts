/**
 * Discover's look-ahead (NP-DISC-007): the next online picks' previews, asked for ahead within a
 * stated budget — two clips, 4 MB, one request at a time — and let go once played or no longer
 * ahead. Every rule is decided without a network or a browser: the module plans, the caller does.
 */
import { describe, expect, it } from 'vitest';
import {
  cachedFor,
  describeCache,
  LOOKAHEAD_BYTES,
  planLookAhead,
  type CacheEntry,
  type Candidate,
} from '../../src/shell/recommend/prefetch.js';

const MB = 1024 * 1024;

const candidate = (n: number, over: Partial<Candidate> = {}): Candidate => ({
  id: `pick-${n}`,
  url: `https://clips.example/${n}.m4a`,
  title: `Song ${n}`,
  artist: 'Alder Quartet',
  platform: 'Apple Music',
  ...over,
});

const entry = (n: number, over: Partial<CacheEntry> = {}): CacheEntry => ({
  id: `pick-${n}`,
  url: `https://clips.example/${n}.m4a`,
  bytes: MB,
  at: n,
  played: false,
  ...over,
});

const three = [candidate(1), candidate(2), candidate(3)];

describe('what the look-ahead asks for', () => {
  it('asks for nothing at all while it is off, and lets go of what it held', () => {
    const plan = planLookAhead({ enabled: false, candidates: three, cache: [entry(1)] });
    expect(plan.fetch).toEqual([]);
    expect(plan.evict).toEqual(['pick-1']);
    expect(plan.reason).toBeNull();
  });

  it('asks for the best pick first, one request at a time', () => {
    const plan = planLookAhead({ enabled: true, candidates: three, cache: [] });
    expect(plan.fetch.map((f) => f.id)).toEqual(['pick-1']);
    const next = planLookAhead({ enabled: true, candidates: three, cache: [entry(1)] });
    expect(next.fetch.map((f) => f.id)).toEqual(['pick-2']);
  });

  it('starts nothing while a request is running, and says so', () => {
    const plan = planLookAhead({ enabled: true, candidates: three, cache: [], inFlight: ['pick-1'] });
    expect(plan.fetch).toEqual([]);
    expect(plan.reason).toBe('A preview is already on its way');
  });

  it('keeps only the depth it promises ahead, and says the ring is full', () => {
    const plan = planLookAhead({ enabled: true, candidates: three, cache: [entry(2), entry(1)] });
    expect(plan.fetch).toEqual([]);
    expect(plan.keep).toEqual(['pick-1', 'pick-2']);
    expect(plan.reason).toBe('2 previews are ready ahead');
  });

  it('passes over a pick with no preview, and says when none ahead has one', () => {
    const plan = planLookAhead({ enabled: true, candidates: [candidate(1, { url: null }), candidate(2)], cache: [] });
    expect(plan.fetch.map((f) => f.id)).toEqual(['pick-2']);
    const none = planLookAhead({ enabled: true, candidates: [candidate(1, { url: null })], cache: [] });
    expect(none.fetch).toEqual([]);
    expect(none.reason).toBe('None of the next picks has a preview to ask for');
  });

  it('stops at the byte budget, measured from what arrived, and explains itself', () => {
    const plan = planLookAhead({ enabled: true, candidates: three, cache: [entry(1, { bytes: 3.5 * MB })], byteBudget: LOOKAHEAD_BYTES });
    expect(plan.fetch).toEqual([]);
    expect(plan.reason).toBe('The look-ahead holds 3.5 MB of the 4.0 MB it may use');
  });

  it('lets go of a played clip and of one no longer ahead', () => {
    const plan = planLookAhead({ enabled: true, candidates: [candidate(2), candidate(3)], cache: [entry(1), entry(2, { played: true })] });
    expect(plan.evict.sort()).toEqual(['pick-1', 'pick-2']);
    expect(plan.fetch.map((f) => f.id)).toEqual(['pick-2']);
  });
});

describe('what the look-ahead hands back', () => {
  it('a clip that arrived and was not played; nothing otherwise', () => {
    const cache = [entry(1), entry(2, { bytes: 0 }), entry(3, { played: true })];
    expect(cachedFor(cache, 'pick-1')?.id).toBe('pick-1');
    expect(cachedFor(cache, 'pick-2')).toBeNull();
    expect(cachedFor(cache, 'pick-3')).toBeNull();
    expect(cachedFor(cache, 'pick-9')).toBeNull();
  });

  it('says what it holds against its budget', () => {
    expect(describeCache([])).toBe('No previews asked for ahead yet.');
    expect(describeCache([entry(1), entry(2, { bytes: MB / 2 })])).toBe('2 previews are ready ahead (1.5 MB of 4.0 MB).');
  });
});
