import { describe, expect, it } from 'vitest';
import { CanonicalTrack, DiscoveryJob, KNOWN_PROVIDERS, SearchResultBase, Track } from '../src/index.js';

const NOW = '2026-09-26T00:00:00.000Z';
const ID = '0190f9a0-0000-7000-8000-000000000001';

function minimalTrack(): Record<string, unknown> {
  return { id: ID, createdAt: NOW, updatedAt: NOW, title: 'A', artistName: 'B' };
}

function minimalResult(): Record<string, unknown> {
  const state = 'unsupported';
  return {
    id: 'spotify:track:x',
    kind: 'track',
    provider: 'spotify',
    providerId: 'x',
    title: 'A',
    capabilities: { metadata: 'available', search: state, preview: state, playback: state, importLikes: state, importPlaylists: state, creatorDownload: state, userOwnedDownload: state, groupSync: 'unsupported', eq: state },
    accessState: 'available',
  };
}

describe('enrichment fields', () => {
  it('canonical tracks default the new fields honestly', () => {
    const t = CanonicalTrack.parse({ id: ID, title: 'A', normalizedTitle: 'a', artistName: 'B', normalizedArtist: 'b', createdAt: NOW, updatedAt: NOW });
    expect(t.featuredArtists).toEqual([]);
    expect(t.genreProfile).toEqual({});
    expect(t.bpm).toBeNull();
    expect(t.bpmSource).toBeNull();
    expect(t.artworkUrl).toBeNull();
    expect(t.matchConfidence).toBeNull();
    expect(t.enrichedAt).toBeNull();
  });

  it('rejects a bpm source outside the known set', () => {
    expect(() => Track.parse({ ...minimalTrack(), bpmSource: 'guess' })).toThrow();
    expect(Track.parse({ ...minimalTrack(), bpmSource: 'preview-analysis' }).bpmSource).toBe('preview-analysis');
  });

  it('search results carry bpm and profile, defaulting to unknown', () => {
    const r = SearchResultBase.parse(minimalResult());
    expect(r.bpm).toBeNull();
    expect(r.bpmSource).toBeNull();
    expect(r.genreProfile).toEqual({});
    expect(r.genres).toEqual([]);
    expect(r.featuredArtists).toEqual([]);
    expect(r.identity.matchConfidence ?? null).toBeNull();
  });

  it('knows the three new metadata providers and the enrich-track job', () => {
    expect(KNOWN_PROVIDERS).toEqual(expect.arrayContaining(['deezer', 'acousticbrainz', 'lastfm']));
    expect(DiscoveryJob.shape.kind.options).toContain('enrich-track');
  });
});
