/**
 * The hub's playlist folder from the admin window (DEC-041; UX-PL-001…UX-PL-008): the routes, and
 * the words both Music ▸ Playlists and Search's Add to Playlist ▸ use.
 */
import { CATALOG_PLATFORM_LABELS, type CatalogTrack, type FolderPlaylistEntry, type FolderPlaylistSummary } from '@now-playing/contracts';
import { api, apiUrl } from './api.js';

export const hubPlaylists = {
  list: (probe: { catalogId?: string; isrc?: string } = {}) => api('playlistsList', { query: probe }),
  page: (playlistId: string, offset: number, limit: number) => api('playlistsGet', { params: { playlistId }, query: { offset, limit } }),
  create: (name: string, tracks: CatalogTrack[] = []) => api('playlistsCreate', { body: { name, tracks } }),
  rename: (playlistId: string, name: string) => api('playlistsUpdate', { params: { playlistId }, body: { name } }),
  remove: (playlistId: string) => api('playlistsDelete', { params: { playlistId } }),
  add: (playlistId: string, tracks: CatalogTrack[]) => api('playlistsAdd', { params: { playlistId }, body: { tracks } }),
  removeEntries: (playlistId: string, entryIds: string[]) => api('playlistsRemove', { params: { playlistId }, body: { entryIds } }),
  move: (playlistId: string, entryId: string, to: number) => api('playlistsMove', { params: { playlistId }, body: { entryId, to } }),
  exportUrl: (playlistId: string) => apiUrl('playlistsExport', { playlistId }),
};

/** "1 h 5 min", "42 min", "3 min": a playlist's length. */
export function lengthText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The line under a playlist's name: "12 songs · 48 min", and where it came from when not from here. */
export function playlistSummaryLine(p: FolderPlaylistSummary): string {
  const songs = p.entryCount === 1 ? '1 song' : `${p.entryCount.toLocaleString('en')} songs`;
  return [songs, p.durationSec ? lengthText(p.durationSec) : null, p.readOnly ? 'made outside Airwave' : null].filter(Boolean).join(' · ');
}

/** Where an entry plays from, in words (UX-PL-004). */
export function whereText(entry: FolderPlaylistEntry): string {
  if (entry.locationKind === 'library') return 'In the library';
  if (entry.locationKind === 'url') {
    const platform = entry.platforms[0] ?? entry.sources[0]?.platform;
    return platform ? `Plays from ${CATALOG_PLATFORM_LABELS[platform]}` : 'Plays from its link';
  }
  return 'Not found: the file isn’t where the list says';
}
