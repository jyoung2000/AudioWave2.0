import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { RecordingMatcher } from '../../src/enrichment/matcher.js';
import type { MusicBrainzAdapter } from '../../src/providers/adapters/musicbrainz.js';

const rec = (over: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000010',
  title: 'Song',
  length: 200_000,
  isrcs: [],
  'artist-credit': [{ name: 'Artist', joinphrase: '', artist: { id: 'x', name: 'Artist' } }],
  releases: [{ id: 'r1', title: 'Album', date: '2017-05-12', status: 'Official', 'release-group': { id: 'rg1', title: 'Album', 'primary-type': 'Album' } }],
  genres: [],
  tags: [],
  ...over,
});

describe('recording matcher', () => {
  let hub: TestHub;
  let matcher: RecordingMatcher;
  beforeEach(async () => {
    hub = await createTestHub();
    matcher = new RecordingMatcher(hub.ctx.providers.get('musicbrainz') as MusicBrainzAdapter, hub.ctx.rateLimiter);
  });
  afterEach(async () => { await hub.close(); });

  it('matches by isrc first', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [rec({ isrcs: ['USUM71703861'] })] } }));
    const m = await matcher.match({ title: 'anything', artistName: 'anyone', durationMs: null, isrc: 'USUM71703861', musicbrainzRecordingId: null, provider: 'soundcloud' });
    expect(m?.via).toBe('isrc');
    expect(m?.confidence).toBe(0.95);
  });

  it('falls through to the title path when the isrc is unknown', async () => {
    hub.fetch.on('query=isrc', () => ({ body: { recordings: [] } }));
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    const m = await matcher.match({ title: 'Song', artistName: 'Artist', durationMs: 200_500, isrc: 'UNKNOWN0000001', musicbrainzRecordingId: null, provider: 'soundcloud' });
    expect(m?.via).toBe('title');
    expect(m!.confidence).toBeCloseTo(1.0, 5);
  });

  it('cleans a YouTube title and its channel before searching', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    const m = await matcher.match({ title: 'Artist - Song (feat. X) [Official Video]', artistName: 'SomeLabelVEVO', channelName: 'SomeLabelVEVO', durationMs: 201_000, isrc: null, musicbrainzRecordingId: null, provider: 'youtube' });
    expect(decodeURIComponent(hub.fetch.calls.at(-1)!.url)).toMatch(/recording:"Song".*artist:"Artist"/);
    expect(m?.cleaned).toEqual({ title: 'Song', artist: 'Artist', featured: ['X'] });
  });

  it('rejects a recording whose length is 40 s off, even with the same title and artist', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec({ length: 240_000 })] } }));
    expect(await matcher.match({ title: 'Song', artistName: 'Artist', durationMs: 200_000, isrc: null, musicbrainzRecordingId: null, provider: 'spotify' })).toBeNull();
  });

  it('rejects a different artist with the same title', async () => {
    hub.fetch.on('query=recording', () => ({ body: { recordings: [rec()] } }));
    expect(await matcher.match({ title: 'Song', artistName: 'Someone Else', durationMs: 200_000, isrc: null, musicbrainzRecordingId: null, provider: 'spotify' })).toBeNull();
  });

  it('uses the mbid directly when the file already carries one', async () => {
    hub.fetch.on('ws/2/recording/aaaaaaaa-0000-4000-8000-000000000010', () => ({ body: rec() }));
    const m = await matcher.match({ title: 'x', artistName: null, durationMs: null, isrc: null, musicbrainzRecordingId: 'aaaaaaaa-0000-4000-8000-000000000010', provider: 'companion' });
    expect(m?.via).toBe('mbid');
    expect(m?.confidence).toBe(1);
  });
});
