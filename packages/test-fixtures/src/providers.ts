import type { ProviderCapabilities, SearchResult } from '@now-playing/contracts';

export const CAPS_FULL: ProviderCapabilities = { metadata: 'available', search: 'available', preview: 'available', playback: 'available', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'available', userOwnedDownload: 'available', groupSync: 'exact', eq: 'available' };
export const CAPS_STREAM_ONLY: ProviderCapabilities = { metadata: 'available', search: 'available', preview: 'available', playback: 'available', importLikes: 'requires_auth', importPlaylists: 'requires_auth', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'best_effort', eq: 'unsupported', reason: 'Embedded player audio is not exposed to Web Audio' };
export const CAPS_METADATA_ONLY: ProviderCapabilities = { metadata: 'available', search: 'available', preview: 'unsupported', playback: 'unsupported', importLikes: 'unsupported', importPlaylists: 'unsupported', creatorDownload: 'unsupported', userOwnedDownload: 'unsupported', groupSync: 'unsupported', eq: 'unsupported', reason: 'MusicBrainz identifies and catalogs music; it is not an audio source' };

/** Fixture search results for two providers used by e2e/integration tests (one of them can be forced to fail). */
export function fixtureSearchResults(provider: string, query: string, caps: ProviderCapabilities): SearchResult[] {
  const q = query.toLowerCase();
  const rows = [
    { id: 'fx-1', title: 'Copper Meridian', artistName: 'Orbital Cartographers', albumName: 'Copper Meridian', durationMs: 305_000 },
    { id: 'fx-2', title: 'Copper Meridian (Radio Edit)', artistName: 'Orbital Cartographers', albumName: 'Singles', durationMs: 180_000 },
    { id: 'fx-3', title: 'Harbour Lights', artistName: 'Cassette Bloom', albumName: 'Live from Pier 9', durationMs: 251_000 },
    { id: 'fx-4', title: 'Lantern Road', artistName: 'Marlow & the Tidewater', albumName: 'Quiet Arithmetic', durationMs: 198_000 },
  ].filter((r) => `${r.title} ${r.artistName} ${r.albumName}`.toLowerCase().includes(q));
  return rows.map((r) => ({
    id: `${provider}:track:${r.id}`,
    kind: 'track',
    provider,
    providerId: r.id,
    title: r.title,
    artistName: r.artistName,
    albumName: r.albumName,
    durationMs: r.durationMs,
    artworkUrl: null,
    canonicalUrl: `https://example.invalid/${provider}/${r.id}`,
    year: 2018,
    genre: 'Electronic',
    capabilities: caps,
    identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: { [provider]: [r.id] } },
    attribution: `${provider} fixture`,
    cachedAt: null,
    stale: false,
    accessState: caps.playback,
    previewUrl: null,
    trackId: null,
    variants: [],
  }));
}
