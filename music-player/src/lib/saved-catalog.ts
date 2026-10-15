import type { CatalogTrack, SavedSongSnapshot, SavedTrack, Track } from '@now-playing/contracts';
import { CatalogPlatform, SavedSongSnapshot as SavedSongSnapshotSchema, SavedTrack as SavedTrackSchema } from '@now-playing/contracts';
import { savedTrackIdentity } from '@now-playing/domain/catalog';

/** Build a shared bookmark from a local like. Only descriptive tags and provider IDs cross the hub boundary. */
export function savedTrackFromLibraryTrack(track: Track, savedAt = new Date().toISOString()): SavedTrack | null {
  const snapshot = SavedSongSnapshotSchema.parse({
    id: track.id,
    title: track.title,
    artist: track.artistName,
    artists: [track.artistName, ...(Array.isArray(track.featuredArtists) ? track.featuredArtists : [])].slice(0, 20),
    album: track.albumName,
    albumArtist: track.albumArtistName,
    durationMs: track.durationMs,
    isrc: track.identity?.isrc?.toUpperCase() ?? null,
    musicbrainzRecordingId: track.identity?.musicbrainzRecordingId ?? null,
    contentHash: track.identity?.contentHash ?? null,
    providerIds: track.identity?.providerIds ?? {},
    artworkUrl: null,
    releaseDate: track.releaseDate ?? null,
    year: track.year,
    genre: track.genre,
    label: null,
    explicit: track.explicit,
    sources: [],
  });
  const identityKey = savedTrackIdentity(snapshot);
  if (!identityKey) return null;
  return SavedTrackSchema.parse({ kind: 'track', identityKey, track: snapshot, savedAt });
}

/** A catalog result becomes a metadata-only shared star, retaining safe public source links. */
export function savedTrackFromCatalogTrack(track: CatalogTrack, savedAt = new Date().toISOString()): SavedTrack | null {
  const isrc = typeof track.isrc === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(track.isrc) ? track.isrc.toUpperCase() : null;
  const parsed = SavedSongSnapshotSchema.safeParse({
    id: track.id,
    title: track.title,
    artist: track.artist,
    artists: Array.isArray(track.artists) ? track.artists : [],
    album: track.album,
    albumArtist: track.albumArtist,
    durationMs: track.durationMs,
    isrc,
    musicbrainzRecordingId: null,
    contentHash: null,
    providerIds: {},
    artworkUrl: track.artworkUrl,
    releaseDate: track.releaseDate,
    year: track.year,
    genre: track.genre,
    label: track.label,
    explicit: track.explicit,
    sources: track.sources,
  });
  if (!parsed.success) return null;
  const identityKey = savedTrackIdentity(parsed.data);
  if (!identityKey) return null;
  return SavedTrackSchema.parse({ kind: 'track', identityKey, track: parsed.data, savedAt });
}

/** Rehydrate only the catalog fields a saved metadata snapshot actually knows. */
export function catalogTrackFromSavedTrack(saved: SavedTrack): CatalogTrack {
  const track = saved.track;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artists: track.artists,
    album: track.album,
    albumArtist: track.albumArtist,
    durationMs: track.durationMs,
    isrc: track.isrc,
    artworkUrl: track.artworkUrl,
    releaseDate: track.releaseDate,
    year: track.year,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: track.explicit,
    genre: track.genre,
    label: track.label,
    sources: track.sources,
    rank: 0,
  };
}

/** A hub search hit has no filesystem locator; retain only its catalog metadata and stable IDs. */
export function savedTrackFromSearchResult(track: {
  provider: string;
  providerId: string;
  title: string;
  artistName: string | null;
  albumName: string | null;
  durationMs: number | null;
  identity: Track['identity'];
  genre: string | null;
  year: number | null;
}): SavedTrack | null {
  const knownProviderIds = track.identity?.providerIds ?? {};
  const hasProviderIds = Object.values(knownProviderIds).some((ids) => ids.length > 0);
  const provider = CatalogPlatform.safeParse(track.provider);
  const providerIds = hasProviderIds ? knownProviderIds : provider.success ? { [provider.data]: [track.providerId] } : {};
  const snapshot: SavedSongSnapshot = SavedSongSnapshotSchema.parse({
    id: `${track.provider}:${track.providerId}`,
    title: track.title,
    artist: track.artistName ?? 'Unknown Artist',
    artists: track.artistName ? [track.artistName] : [],
    album: track.albumName,
    albumArtist: null,
    durationMs: track.durationMs,
    isrc: track.identity?.isrc ?? null,
    musicbrainzRecordingId: track.identity?.musicbrainzRecordingId ?? null,
    contentHash: track.identity?.contentHash ?? null,
    providerIds,
    artworkUrl: null,
    releaseDate: null,
    year: track.year,
    genre: track.genre,
    label: null,
    explicit: null,
    sources: [],
  });
  const identityKey = savedTrackIdentity(snapshot);
  if (!identityKey) return null;
  return SavedTrackSchema.parse({ kind: 'track', identityKey, track: snapshot, savedAt: new Date().toISOString() });
}
