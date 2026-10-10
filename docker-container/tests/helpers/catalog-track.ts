import type { CatalogTrack } from '@now-playing/contracts';

/** A song as search finds it on Deezer: what a test files into a playlist. */
export function catalogTrack(id: string, title: string, artist: string, extra: Partial<CatalogTrack> = {}): CatalogTrack {
  return {
    id: `deezer:${id}`,
    title,
    artist,
    artists: [artist],
    album: null,
    albumArtist: null,
    durationMs: 200_000,
    isrc: null,
    artworkUrl: `https://cdn-images.dzcdn.net/images/cover/${id}/250x250.jpg`,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: null,
    label: null,
    sources: [{ platform: 'deezer', id, url: `https://www.deezer.com/track/${id}`, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
    ...extra,
  };
}
