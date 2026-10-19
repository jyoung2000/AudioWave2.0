/**
 * What a listening event remembers about a song.
 *
 * The recommender learns from these snapshots: `genres`, `tags`, `bpm` and the artist and album ids
 * are the inputs behind its genre, tempo and artist factors (`packages/recommendations`). A field
 * dropped on the way out of the library is a factor the algorithm can never score, however good the
 * library's own tags are — so these cover the two places a snapshot is built.
 */
import { describe, expect, it } from 'vitest';
import type { Track } from '@now-playing/contracts';
import { toTrackRef } from '../../src/state/store.js';

/** A fully tagged library song: everything the recommender can use is present. */
function tagged(): Track {
  return {
    id: '0192a7c1-2b3d-7e4f-8a9b-000000000001',
    title: 'Fennel Fields',
    artistName: 'Fennel Grove',
    artistId: '0192a7c1-2b3d-7e4f-8a9b-0000000000a1',
    albumName: 'Hedgerow',
    albumId: '0192a7c1-2b3d-7e4f-8a9b-0000000000b1',
    albumArtist: 'Fennel Grove',
    trackNumber: 3,
    discNumber: 1,
    durationMs: 214_000,
    genre: 'Folk',
    genres: ['Folk', 'Indie Folk'],
    tags: ['acoustic', 'autumn'],
    year: 2021,
    bpm: 96,
    artworkId: null,
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
    locators: [],
    provider: 'local',
    addedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    playCount: 0,
    lastPlayedAt: null,
    liked: false,
    rating: null,
    lyrics: null,
    comment: null,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    codec: null,
    sizeBytes: null,
    fileName: null,
    folder: null,
  } as unknown as Track;
}

describe('a track reference keeps what the recommender scores on', () => {
  it('carries the plural genres, the tags, the tempo and the artist and album ids', () => {
    const ref = toTrackRef(tagged());
    // The singular genre was already kept; these are the ones that were being dropped.
    expect(ref.genre).toBe('Folk');
    expect(ref.genres).toEqual(['Folk', 'Indie Folk']);
    expect(ref.bpm).toBe(96);
    // Ids, so two artists who share a name are not learned as one taste.
    expect(ref.artistId).toBe('0192a7c1-2b3d-7e4f-8a9b-0000000000a1');
    expect(ref.albumId).toBe('0192a7c1-2b3d-7e4f-8a9b-0000000000b1');
    expect(ref.tags).toEqual(['acoustic', 'autumn']);
  });

  it('leaves a song with nothing to say empty rather than inventing values', () => {
    const bare = { ...tagged(), genre: null, genres: [], tags: [], bpm: null, artistId: null, albumId: null } as unknown as Track;
    const ref = toTrackRef(bare);
    expect(ref.genre).toBeNull();
    expect(ref.genres).toEqual([]);
    expect(ref.bpm).toBeNull();
    expect(ref.artistId).toBeNull();
    expect(ref.tags).toEqual([]);
  });
});
