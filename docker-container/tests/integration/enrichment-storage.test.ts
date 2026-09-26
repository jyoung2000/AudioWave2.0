import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CanonicalTrack } from '@now-playing/contracts';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const NOW = '2026-09-26T00:00:00.000Z';

function row(id: string, over: Partial<CanonicalTrack> = {}): CanonicalTrack {
  return {
    id, musicbrainzRecordingId: null, isrc: null, title: 'Song', normalizedTitle: 'song', artistId: null, artistName: 'Artist', normalizedArtist: 'artist',
    albumId: null, albumName: null, releaseYear: null, durationMs: 200_000, genres: [], tags: [], popularity: null, createdAt: NOW, updatedAt: NOW,
    featuredArtists: [], genreProfile: {}, bpm: null, bpmSource: null, artworkUrl: null, matchConfidence: null, enrichedAt: null,
    ...over,
  };
}

describe('canonical tracks keep enrichment', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub(); });
  afterEach(async () => { await hub.close(); });

  it('round-trips album, features, profile, bpm, artwork and confidence', () => {
    hub.ctx.repos.canonical.upsertTrack(row('0190f9a0-0000-7000-8000-00000000aa01', {
      isrc: 'USUM71703861', albumName: 'Album', releaseYear: 2017, genres: ['hip hop'], tags: ['summer'],
      featuredArtists: ['Guest'], genreProfile: { 'hip hop': 0.7, trap: 0.3 }, bpm: 98, bpmSource: 'deezer',
      artworkUrl: 'https://coverartarchive.org/release-group/x/front-250', matchConfidence: 0.92, enrichedAt: NOW,
    }));
    const back = hub.ctx.repos.canonical.findTrackByIsrc('USUM71703861');
    expect(back?.featuredArtists).toEqual(['Guest']);
    expect(back?.genreProfile).toEqual({ 'hip hop': 0.7, trap: 0.3 });
    expect(back?.bpm).toBe(98);
    expect(back?.bpmSource).toBe('deezer');
    expect(back?.artworkUrl).toContain('coverartarchive');
    expect(back?.matchConfidence).toBe(0.92);
    expect(back?.enrichedAt).toBe(NOW);
  });

  it('a later upsert without enrichment does not erase what a job filled', () => {
    const id = '0190f9a0-0000-7000-8000-00000000aa02';
    hub.ctx.repos.canonical.upsertTrack(row(id, { bpm: 120, bpmSource: 'deezer', albumName: 'Album', enrichedAt: NOW, matchConfidence: 0.95 }));
    hub.ctx.repos.canonical.upsertTrack(row(id));
    const back = hub.ctx.repos.canonical.findTrackById(id);
    expect(back?.bpm).toBe(120);
    expect(back?.albumName).toBe('Album');
    expect(back?.enrichedAt).toBe(NOW);
  });

  it('lists tracks that were never enriched, oldest first', () => {
    hub.ctx.repos.canonical.upsertTrack(row('0190f9a0-0000-7000-8000-00000000aa03', { createdAt: '2026-09-25T00:00:00.000Z', enrichedAt: NOW }));
    hub.ctx.repos.canonical.upsertTrack(row('0190f9a0-0000-7000-8000-00000000aa04', { createdAt: '2026-09-24T00:00:00.000Z' }));
    hub.ctx.repos.canonical.upsertTrack(row('0190f9a0-0000-7000-8000-00000000aa05', { createdAt: '2026-09-23T00:00:00.000Z' }));
    expect(hub.ctx.repos.canonical.tracksNeedingEnrichment(10).map((t) => t.id)).toEqual(['0190f9a0-0000-7000-8000-00000000aa05', '0190f9a0-0000-7000-8000-00000000aa04']);
  });
});
