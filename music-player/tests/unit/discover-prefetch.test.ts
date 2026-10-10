/**
 * Discover's look-ahead ring (NP-DISC-007): fetch the next track while this one plays, evict it when
 * the playhead passes it unless it was starred, and never start a fetch that cannot finish in time.
 * Every rule here is decided without a network, a browser or a file — the module plans, the caller
 * does — which is what makes them testable at all.
 */
import { describe, expect, it } from 'vitest';
import {
  cachedNext,
  describeCache,
  planLookAhead,
  type CacheEntry,
  type Candidate,
} from '../../src/shell/recommend/prefetch.js';

const MB = 1024 * 1024;

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'https://youtu.be/one',
  url: 'https://youtu.be/one',
  title: 'One',
  artist: 'Alder Quartet',
  platform: 'youtube',
  ...over,
});

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  id: 'https://youtu.be/one',
  title: 'One',
  artist: 'Alder Quartet',
  platform: 'youtube',
  url: 'https://youtu.be/one',
  bytes: 5 * MB,
  at: 1,
  played: false,
  starred: false,
  ...over,
});

/** The common shape: look-ahead on, a long song left, an empty ring, one candidate. */
const base = (over: Partial<Parameters<typeof planLookAhead>[0]> = {}) => ({
  enabled: true,
  remainingSec: 200,
  candidates: [candidate()],
  cache: [] as CacheEntry[],
  byteBudget: 64 * MB,
  ...over,
});

describe('the look-ahead plan', () => {
  it('plans nothing at all while the person has not switched it on', () => {
    const { fetch, reason } = planLookAhead(base({ enabled: false }));
    expect(fetch).toEqual([]);
    expect(reason).toBeNull();
  });

  it('fetches the best candidates first, up to the depth of the ring', () => {
    const three = [candidate({ id: 'a', url: 'https://youtu.be/a' }), candidate({ id: 'b', url: 'https://youtu.be/b' }), candidate({ id: 'c', url: 'https://youtu.be/c' })];
    const { fetch, reason } = planLookAhead(base({ candidates: three, depth: 2 }));
    expect(fetch.map((f) => f.id)).toEqual(['a', 'b']);
    expect(reason).toBeNull();
    expect(fetch[0]!.why).toContain('while this song plays');
  });

  it('never starts the same row twice, whether it is cached or already on its way', () => {
    const { fetch } = planLookAhead(
      base({
        candidates: [candidate({ id: 'a', url: 'https://youtu.be/a' }), candidate({ id: 'b', url: 'https://youtu.be/b' })],
        cache: [entry({ id: 'a', url: 'https://youtu.be/a' })],
        inFlight: ['b'],
        depth: 2,
      }),
    );
    expect(fetch).toEqual([]);
  });

  it('will not start a fetch that cannot finish before the song does, and says how long was left', () => {
    const { fetch, reason } = planLookAhead(base({ remainingSec: 8, estimateFetchSec: 12, slackSec: 15 }));
    expect(fetch).toEqual([]);
    expect(reason).toContain('8s of this song left');
    expect(reason).toContain('12s');
  });

  it('says the ring is already full rather than planning nothing in silence', () => {
    const { fetch, reason } = planLookAhead(
      base({ cache: [entry({ id: 'a', url: 'https://youtu.be/a' }), entry({ id: 'b', url: 'https://youtu.be/b' })], depth: 2 }),
    );
    expect(fetch).toEqual([]);
    expect(reason).toContain('already ready');
  });

  it('skips a row with no address, because there is nothing to fetch', () => {
    const noUrl = candidate({ id: 'no-url', url: null, title: 'No Address' });
    const { fetch } = planLookAhead(base({ candidates: [noUrl], depth: 1 }));
    expect(fetch).toEqual([]);
    expect(planLookAhead(base({ candidates: [noUrl], depth: 1 })).reason).toContain('on its way');
  });

  it('stops at the byte budget and explains itself', () => {
    const big = [candidate({ id: 'a', url: 'https://youtu.be/a' }), candidate({ id: 'b', url: 'https://youtu.be/b' })];
    const { fetch, reason } = planLookAhead(
      base({ candidates: big, depth: 2, byteBudget: 6 * MB, estimateBytes: 5 * MB, cache: [entry({ id: 'held', url: 'https://youtu.be/held', bytes: 5 * MB })] }),
    );
    // One fits (5 MB held + 5 MB = 10 MB > 6 MB is already over, so nothing further is planned).
    expect(fetch).toHaveLength(0);
    expect(reason).toContain('ring is full');
  });
});

describe('what the ring keeps', () => {
  it('evicts what the playhead has passed, and never evicts what was starred', () => {
    const played = entry({ id: 'played', url: 'https://youtu.be/played', played: true });
    const kept = entry({ id: 'kept', url: 'https://youtu.be/kept', played: true, starred: true });
    const { evict, keep } = planLookAhead(base({ cache: [played, kept] }));
    expect(evict).toContain('played');
    expect(evict).not.toContain('kept');
    expect(keep).toContain('kept');
  });

  it('keeps only the depth it promises ahead, and turns the rest over', () => {
    const ring = [
      entry({ id: 'a', url: 'https://youtu.be/a' }),
      entry({ id: 'b', url: 'https://youtu.be/b' }),
      entry({ id: 'c', url: 'https://youtu.be/c' }),
    ];
    const { evict, keep } = planLookAhead(base({ cache: ring, depth: 2 }));
    expect(keep).toEqual(['a', 'b']);
    expect(evict).toContain('c');
  });

  it('still evicts when look-ahead is off, so turning it off does not strand files', () => {
    const { evict } = planLookAhead(base({ enabled: false, cache: [entry({ id: 'played', played: true })] }));
    expect(evict).toEqual(['played']);
  });
});

describe('the instant hand-off', () => {
  it('hands off the oldest track that is actually on disk', () => {
    const cache = [entry({ id: 'later', at: 9 }), entry({ id: 'sooner', at: 2, url: 'https://youtu.be/sooner' })];
    expect(cachedNext(cache)!.id).toBe('sooner');
  });

  it('will not play a half-written file, and hands off nothing when the ring is empty', () => {
    expect(cachedNext([entry({ id: 'writing', bytes: 0 })])).toBeNull();
    expect(cachedNext([])).toBeNull();
  });

  it('never hands back something already played', () => {
    expect(cachedNext([entry({ id: 'done', played: true })])).toBeNull();
  });

  it('says what the ring is holding, and whether anything was kept', () => {
    expect(describeCache([])).toBe('Nothing fetched ahead yet.');
    expect(describeCache([entry()])).toBe('1 track ready ahead of this song.');
    expect(describeCache([entry(), entry({ id: 'two', url: 'https://youtu.be/two', starred: true })])).toBe(
      '2 tracks ready, 1 kept in your library.',
    );
  });
});
