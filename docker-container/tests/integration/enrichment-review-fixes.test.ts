import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '@now-playing/contracts';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { caps } from '../../src/providers/adapters/base.js';

/**
 * Fixes from the whole-branch review (C1, I1–I4, I6): every test here reproduced a defect the
 * reviewer found before the fix landed, and pins it now.
 */

const MBID = 'aaaaaaaa-0000-4000-8000-000000000010';
const RECORDING = (over: Record<string, unknown> = {}) => ({
  id: MBID,
  title: 'Song',
  length: 200_000,
  isrcs: [],
  'artist-credit': [
    { name: 'Artist', joinphrase: ' feat. ', artist: { id: 'x', name: 'Artist' } },
    { name: 'Guest', joinphrase: '', artist: { id: 'y', name: 'Guest' } },
  ],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [{ name: 'hip hop', count: 12 }],
  tags: [],
  ...over,
});

function result(over: Omit<Partial<SearchResult>, 'identity'> & { identity?: Partial<SearchResult['identity']> } = {}): SearchResult {
  const identity = { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {}, ...(over.identity ?? {}) };
  return {
    id: 'spotify:track:abc', kind: 'track', provider: 'spotify', providerId: 'abc', title: 'Song', artistName: 'Artist', albumName: null,
    durationMs: 200_000, artworkUrl: null, canonicalUrl: null, year: null, genre: null, genres: [], genreProfile: {}, featuredArtists: [],
    bpm: null, bpmSource: null, capabilities: caps({ metadata: 'available' }), attribution: null, cachedAt: null, stale: false,
    accessState: 'available', previewUrl: null, trackId: null, variants: [], ...over, identity,
  } as SearchResult;
}

describe('review fixes: identity, honesty and retry', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('C1: a matched YouTube result gets its enrichment on the next answer, and is not re-queued', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [RECORDING()] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    hub.fetch.on(`acousticbrainz.org/api/v1/${MBID}/low-level`, () => ({ status: 404, body: {} }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [] } }));
    const yt = () => result({ id: 'youtube:track:v1', provider: 'youtube', providerId: 'v1', title: 'Artist - Song (feat. Guest) [Official Video]', artistName: 'SomeLabelVEVO', durationMs: 201_000 });
    await hub.ctx.enrichment.enrichResult(yt(), 200);
    expect((await hub.ctx.jobs.runJobOnce())?.state).toBe('completed');
    const out = await hub.ctx.enrichment.enrichResult(yt(), 200);
    expect(out.albumName).toBe('Album');
    expect(out.artistName).toBe('Artist');
    expect(out.featuredArtists).toEqual(['Guest']);
    expect(out.identity.matchConfidence).toBeGreaterThanOrEqual(0.8);
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(0);
  });

  it('I1: the recommender’s row and the job’s row are the same row', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [RECORDING({ title: "Don't Stop", 'artist-credit': [{ name: 'The Band', joinphrase: '', artist: { id: 'x', name: 'The Band' } }] })] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    hub.fetch.on(`acousticbrainz.org/api/v1/${MBID}/low-level`, () => ({ status: 404, body: {} }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [] } }));
    hub.ctx.recommendations.canonicalise({ title: "Don't Stop", artistName: 'The Band', durationMs: 200_000, provider: 'companion', providerTrackId: 'c1' });
    expect((await hub.ctx.jobs.runJobOnce())?.kind).toBe('enrich-track');
    const rows = hub.ctx.db.prepare("SELECT enriched_at FROM canonical_tracks WHERE title LIKE '%Stop%'").all() as Array<{ enriched_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enriched_at).not.toBeNull();
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(0);
  });

  it('I2: a match that brings no genres does not erase the ones the file carried', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [RECORDING({ genres: [], tags: [] })] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    hub.fetch.on(`acousticbrainz.org/api/v1/${MBID}/low-level`, () => ({ status: 404, body: {} }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [] } }));
    hub.ctx.recommendations.canonicalise({ title: 'Song', artistName: 'Artist', durationMs: 200_000, genres: ['Soundtrack'], tags: ['mytag'], provider: 'companion', providerTrackId: 'c2' });
    await hub.ctx.jobs.runJobOnce();
    const row = hub.ctx.db.prepare('SELECT genres, tags FROM canonical_tracks WHERE enriched_at IS NOT NULL').get() as { genres: string; tags: string };
    expect((JSON.parse(row.genres) as string[]).map((g) => g.toLowerCase())).toContain('soundtrack');
    expect(JSON.parse(row.tags)).toContain('mytag');
  });

  it('I3: a Deezer 503 leaves the job to retry with backoff, and the retry finishes it', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [RECORDING({ isrcs: ['USUM71703861'] })] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    let deezerUp = false;
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703861', () => (deezerUp ? { body: { id: 1, bpm: 98, duration: 200 } } : { status: 503, body: {} }));
    await hub.ctx.enrichment.enrichResult(result({ identity: { isrc: 'USUM71703861' } }), 200);
    await hub.ctx.jobs.runJobOnce();
    expect(hub.ctx.repos.canonical.jobCounts()['queued'] ?? 0).toBe(1);
    expect(hub.ctx.db.prepare('SELECT COUNT(*) AS n FROM canonical_tracks WHERE enriched_at IS NOT NULL').get()).toMatchObject({ n: 0 });
    deezerUp = true;
    hub.clock.advance(121_000); // attempt 1 backs off up to 60 s with jitter
    expect((await hub.ctx.jobs.runJobOnce())?.state).toBe('completed');
    const out = await hub.ctx.enrichment.enrichResult(result({ identity: { isrc: 'USUM71703861' } }), 200);
    expect(out.bpm).toBe(98);
  });

  it('I6: an unmatched track gets no tempo from a fuzzy name search', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [] } }));
    hub.fetch.on('api.deezer.com/search', () => ({ body: { data: [{ id: 7, duration: 200, title: 'Song', artist: { name: 'Somebody Else' } }] } }));
    hub.fetch.on('api.deezer.com/track/7', () => ({ body: { id: 7, bpm: 120 } }));
    await hub.ctx.enrichment.enrichResult(result(), 200);
    await hub.ctx.jobs.runJobOnce();
    const out = await hub.ctx.enrichment.enrichResult(result(), 200);
    expect(out.bpm).toBeNull();
    expect(hub.fetch.calls.filter((c) => c.url.includes('api.deezer.com/search'))).toHaveLength(0);
  });

  it('a matched track whose Deezer says 0 falls through to AcousticBrainz', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [RECORDING({ isrcs: ['USUM71703862'] })] } }));
    hub.fetch.on('coverartarchive.org/release-group/rg1', () => ({ body: { images: [{ front: true }] } }));
    hub.fetch.on('api.deezer.com/track/isrc:USUM71703862', () => ({ body: { id: 2, bpm: 0, duration: 200 } }));
    hub.fetch.on(`acousticbrainz.org/api/v1/${MBID}/low-level`, () => ({ body: { rhythm: { bpm: 174.2 } } }));
    await hub.ctx.enrichment.enrichResult(result({ identity: { isrc: 'USUM71703862' } }), 200);
    await hub.ctx.jobs.runJobOnce();
    const out = await hub.ctx.enrichment.enrichResult(result({ identity: { isrc: 'USUM71703862' } }), 200);
    expect(out.bpm).toBe(174);
    expect(out.bpmSource).toBe('acousticbrainz');
  });
});

describe('review fixes: the scheduler is not held hostage', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('I4: a hung enrichment job does not stop the periodic tasks', async () => {
    hub.ctx.jobs.handle('enrich-track', () => new Promise<void>(() => { /* never resolves */ }));
    hub.ctx.jobs.enqueue({ userId: '00000000-0000-4000-8000-00000000e001', kind: 'enrich-track', payload: { key: 'x:y' } });
    let ran = 0;
    hub.ctx.jobs.register({ name: 'probe', intervalMs: 0, run: () => { ran += 1; } });
    const tick = (hub.ctx.jobs as unknown as { tick(): Promise<void> }).tick.bind(hub.ctx.jobs);
    await tick();
    expect(ran).toBe(1);
    hub.clock.advance(5_000);
    await tick();
    expect(ran).toBe(2); // before the fix, the second tick waits on the hung job forever
  });

  it('I4: one tick drains every due enrichment job, not one per five seconds', async () => {
    const done: string[] = [];
    hub.ctx.jobs.handle('enrich-track', (job) => { done.push(job.id); });
    hub.ctx.jobs.enqueue({ userId: '00000000-0000-4000-8000-00000000e001', kind: 'enrich-track', payload: { key: 'a:1' } });
    hub.ctx.jobs.enqueue({ userId: '00000000-0000-4000-8000-00000000e001', kind: 'enrich-track', payload: { key: 'b:2' } });
    const tick = (hub.ctx.jobs as unknown as { tick(): Promise<void> }).tick.bind(hub.ctx.jobs);
    await tick();
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toHaveLength(2);
  });
});
