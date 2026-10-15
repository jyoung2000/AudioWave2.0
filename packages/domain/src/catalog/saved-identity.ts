import type { CatalogTrack, SavedSongSnapshot } from '@now-playing/contracts';

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
type SongIdentitySource = Pick<CatalogTrack, 'id' | 'isrc' | 'sources'> | SavedSongSnapshot;

/** A stable bookmark key; titles never form identity because distinct recordings can share them. */
export function savedTrackIdentity(track: SongIdentitySource, contentHash?: string | null): string | null {
  const isrc = track.isrc?.toUpperCase().replace(/[-\s]/g, '');
  if (isrc && ISRC.test(isrc)) return `isrc:${isrc}`;

  const explicitRecordingId = 'musicbrainzRecordingId' in track ? track.musicbrainzRecordingId : null;
  const recordingId = explicitRecordingId ?? /(?:^|:)recording:([0-9a-f-]{36})$/i.exec(track.id)?.[1] ?? track.sources.find((source) => source.platform === 'musicbrainz' && source.id !== null && UUID.test(source.id))?.id;
  if (recordingId && UUID.test(recordingId)) return `musicbrainz:${recordingId.toLowerCase()}`;

  const source = track.sources.find((candidate) => candidate.id !== null && candidate.id.trim().length > 0);
  if (source?.id) return `provider:${source.platform}:${source.id.trim()}`;
  if ('providerIds' in track) {
    const providerEntry = Object.entries(track.providerIds).sort(([a], [b]) => a.localeCompare(b)).find(([, values]) => values.length > 0);
    const id = providerEntry?.[1].slice().sort()[0];
    if (providerEntry && id) return `provider:${providerEntry[0]}:${id}`;
  }

  const hash = contentHash ?? ('contentHash' in track ? track.contentHash : null);
  if (hash && SHA256.test(hash)) return `sha256:${hash.toLowerCase()}`;
  return null;
}
