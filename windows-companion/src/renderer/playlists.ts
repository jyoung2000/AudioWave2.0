/**
 * The companion's playlist folder from the window (DEC-041; CMP-PL-001…CMP-PL-006): the `playlists:*`
 * channels, with an answer's reason turned into an error so a view can say it. The words shown are
 * the domain's, shared with the hub.
 */
import type { CatalogTrack, FolderPlaylistAddResult, FolderPlaylistPage, FolderPlaylistSummary } from '@now-playing/contracts';
import { invoke } from './bridge.js';

export { folderEntryWhere as whereText, folderPlaylistLine as playlistSummaryLine, playlistLengthText as lengthText } from '@now-playing/domain/catalog';

function settled<T>(answer: { result: T | null; reason: string | null }): T {
  if (answer.result === null) throw new Error(answer.reason ?? 'The playlist folder didn’t answer.');
  return answer.result;
}

export const companionPlaylists = {
  list: (probe: { catalogId?: string; isrc?: string } = {}) => invoke('playlists:list', probe),
  page: async (playlistId: string, offset: number, limit: number): Promise<FolderPlaylistPage> => settled(await invoke('playlists:get', { playlistId, offset, limit })),
  create: async (name: string, tracks: CatalogTrack[] = []): Promise<FolderPlaylistSummary> => settled(await invoke('playlists:create', { name, tracks })),
  rename: async (playlistId: string, name: string): Promise<FolderPlaylistSummary> => settled(await invoke('playlists:update', { playlistId, name })),
  remove: async (playlistId: string): Promise<void> => {
    const answer = await invoke('playlists:delete', { playlistId });
    if (!answer.ok) throw new Error(answer.reason ?? 'The playlist couldn’t be deleted.');
  },
  add: async (playlistId: string, tracks: CatalogTrack[]): Promise<FolderPlaylistAddResult> => settled(await invoke('playlists:add', { playlistId, tracks, allowDuplicates: false })),
  removeEntries: async (playlistId: string, entryIds: string[]): Promise<FolderPlaylistSummary> => settled(await invoke('playlists:remove', { playlistId, entryIds })),
  move: async (playlistId: string, entryId: string, to: number): Promise<FolderPlaylistSummary> => settled(await invoke('playlists:move', { playlistId, entryId, to })),
  exportFile: (playlistId: string) => invoke('playlists:export', { playlistId }),
};
