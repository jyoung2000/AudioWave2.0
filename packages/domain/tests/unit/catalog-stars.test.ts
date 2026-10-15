import { describe, expect, it } from 'vitest';
import { CatalogTrack } from '@now-playing/contracts';
import { savedTrackIdentity } from '@now-playing/domain/catalog';

const track = (patch: Record<string, unknown> = {}) =>
  CatalogTrack.parse({
    id: 'deezer:42',
    title: 'Harbour Lights',
    artist: 'North Quay',
    sources: [{ platform: 'deezer', id: '42', url: 'https://www.deezer.com/track/42', previewUrl: null }],
    ...patch,
  });

describe('shared saved-song identity', () => {
  it('prefers a validated ISRC, then MusicBrainz recording, then provider ID, then content hash', () => {
    const isrc = track({ isrc: 'GBAAA1900001', id: 'musicbrainz:recording:123e4567-e89b-12d3-a456-426614174000' });
    expect(savedTrackIdentity(isrc, 'a'.repeat(64))).toBe('isrc:GBAAA1900001');

    const musicbrainz = track({ id: 'musicbrainz:recording:123e4567-e89b-12d3-a456-426614174000', sources: [{ platform: 'musicbrainz', id: '123e4567-e89b-12d3-a456-426614174000', url: 'https://musicbrainz.org/recording/123e4567-e89b-12d3-a456-426614174000', previewUrl: null }] });
    expect(savedTrackIdentity(musicbrainz)).toBe('musicbrainz:123e4567-e89b-12d3-a456-426614174000');

    expect(savedTrackIdentity(track())).toBe('provider:deezer:42');
    const noProvider = { ...track(), sources: [] } as unknown as ReturnType<typeof track>;
    expect(savedTrackIdentity(noProvider, 'a'.repeat(64))).toBe('sha256:' + 'a'.repeat(64));
  });

  it('never merges title-only songs and rejects malformed content hashes', () => {
    const titleOnly = { ...track(), sources: [] } as unknown as ReturnType<typeof track>;
    expect(savedTrackIdentity(titleOnly)).toBeNull();
    expect(savedTrackIdentity(titleOnly, 'not-a-hash')).toBeNull();
  });
});
