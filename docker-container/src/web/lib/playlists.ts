/**
 * The hub's playlist folder from the admin window (DEC-041; UX-PL-001…UX-PL-008): the routes Music ▸
 * Playlists and Search's Add to Playlist ▸ call. The words both say are the domain's
 * (`folderPlaylistLine`, `folderEntryWhere`, `playlistLengthText`), shared with the companion.
 */
import type { CatalogTrack } from '@now-playing/contracts';
import { api, apiUrl } from './api.js';

export { folderEntryWhere as whereText, folderPlaylistLine as playlistSummaryLine, playlistLengthText as lengthText } from '@now-playing/domain/catalog';

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
