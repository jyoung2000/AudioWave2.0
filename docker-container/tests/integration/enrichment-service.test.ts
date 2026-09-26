import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '@now-playing/contracts';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { caps } from '../../src/providers/adapters/base.js';

const RECORDING = {
  id: 'aaaaaaaa-0000-4000-8000-000000000010',
  title: 'Song',
  length: 200_000,
  isrcs: ['USUM71703861'],
  'artist-credit': [
    { name: 'Artist', joinphrase: ' feat. ', artist: { id: 'x', name: 'Artist' } },
    { name: 'Guest', joinphrase: '', artist: { id: 'y', name: 'Guest' } },
  ],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [{ name: 'hip hop', count: 12 }, { name: 'trap', count: 4 }],
  tags: [{ name: 'summer', count: 3 }],
};

function spotifyResult(isrc: string | null = 'USUM71703861'): SearchResult {
  return {
    id: 'spotify:track:abc', kind: 'track', provider: 'spotify', providerId: 'abc', title: 'Song', artistName: 'Artist', albumName: null, durationMs: 200_000,
    artworkUrl: null, canonicalUrl: null, year: null, genre: null, genres: [], genreProfile: {}, featuredArtists: [], bpm: null, bpmSource: null,
    capabilities: caps({ metadata: 'available' }),
    identity: { contentHash: null, quickHash: null, isrc, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    attribution: null, cachedAt: null, stale: false, accessState: 'available', previewUrl: null, trackId: null, variants: [],
  };
}

describe('enrichment service', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('answers at once from an empty cache and queues one job per result', async () => {
    const out = await hub.ctx.enrichment.enrichResult(spotifyResult(), 200);
    expect(out.albumName).toBeNull();
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(1);
    await hub.ctx.enrichment.enrichResult(spotifyResult(), 200);
    expect(hub.ctx.repos.canonical.jobCounts()['queued']).toBe(1);
  });

  it('the job fills album, features, cover, profile and bpm, and the next answer comes from the cache', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [RECORDING] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => ({ body: { id: 1, bpm: 98, duration: 200 } }));
    await hub.ctx.enrichment.enrichResult(spotifyResult(), 200);
    const ran = await hub.ctx.jobs.runJobOnce();
    expect(ran?.kind).toBe('enrich-track');
    const out = await hub.ctx.enrichment.enrichResult(spotifyResult(), 200);
    expect(out.albumName).toBe('Album');
    expect(out.featuredArtists).toEqual(['Guest']);
    expect(out.artworkUrl).toBe('https://coverartarchive.org/release-group/rg1/front-250');
    expect(out.genreProfile['hip hop']).toBeGreaterThan(out.genreProfile['trap']!);
    expect(out.bpm).toBe(98);
    expect(out.bpmSource).toBe('deezer');
    expect(out.identity.matchConfidence).toBe(0.95);
    expect(hub.fetch.calls.filter((c) => c.url.includes('acousticbrainz'))).toHaveLength(0);
  });

  it('records a no-match honestly and does not retry it', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [] } }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [] } }));
    await hub.ctx.enrichment.enrichResult(spotifyResult(null), 200);
    await hub.ctx.jobs.runJobOnce();
    const out = await hub.ctx.enrichment.enrichResult(spotifyResult(null), 200);
    expect(out.albumName).toBeNull();
    expect(out.identity.matchConfidence).toBe(0);
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(0);
  });

  it('a transport failure leaves the job to be retried, not finished', async () => {
    hub.fetch.on('query=isrc', () => ({ status: 503, body: {} }));
    await hub.ctx.enrichment.enrichResult(spotifyResult(), 200);
    await hub.ctx.jobs.runJobOnce();
    const counts = hub.ctx.repos.canonical.jobCounts();
    expect((counts['queued'] ?? 0) + (counts['failed'] ?? 0)).toBe(1);
    expect(counts['done'] ?? 0).toBe(0);
  });
});
