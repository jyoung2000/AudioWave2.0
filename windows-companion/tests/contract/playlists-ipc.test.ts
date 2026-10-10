/**
 * The playlist folder's IPC (DEC-041; CMP-PL-001…CMP-PL-004): every `playlists:*` channel is in the
 * preload's allowlist and the registry, the window can never name a folder (the picker is the only
 * way the preference changes), requests refuse what they do not know, and the answers are the shapes
 * the hub's `/api/v1/playlists` serves.
 */
import { describe, expect, it } from 'vitest';
import { FolderPlaylistList, FolderPlaylistSummary } from '@now-playing/contracts';
import { IPC, IPC_CHANNELS, IPC_EVENTS, IPC_EVENT_NAMES, PreferencesPatch, Preferences } from '../../src/shared/ipc.js';

const CHANNELS = ['playlists:list', 'playlists:get', 'playlists:create', 'playlists:update', 'playlists:delete', 'playlists:add', 'playlists:remove', 'playlists:move', 'playlists:export', 'playlists:folder', 'playlists:pick-dir', 'playlists:open-folder'] as const;

const TRACK = {
  id: 'deezer:1',
  title: 'Harbour Lights',
  artist: 'Cassette Bloom',
  sources: [{ platform: 'deezer', id: '1', url: 'https://www.deezer.com/track/1' }],
};

describe('the playlists:* channels', () => {
  it('are all allowlisted and registered, with the change event', () => {
    for (const channel of CHANNELS) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(IPC[channel]).toBeTruthy();
    }
    expect(IPC_EVENT_NAMES).toContain('event:playlists-changed');
    expect(IPC_EVENTS['event:playlists-changed'].parse({ at: '2026-10-10T12:00:00.000Z' })).toBeTruthy();
  });

  it('never take a folder from the window: the picker and Open Folder take no path, and preferences refuse one', () => {
    expect(IPC['playlists:pick-dir'].request.safeParse({ move: true, path: 'C:\\Windows' }).success).toBe(false);
    expect(IPC['playlists:pick-dir'].request.parse({})).toEqual({ move: true });
    expect(IPC['playlists:open-folder'].request.safeParse(undefined).success).toBe(true);
    expect(PreferencesPatch.safeParse({ playlistDir: 'C:\\Users\\Example\\Music' }).success).toBe(false);
    expect(Preferences.parse({}).playlistDir).toBeNull();
  });

  it('take ids, not paths, and refuse what they do not know', () => {
    expect(IPC['playlists:get'].request.safeParse({ playlistId: '../../secret', offset: 0, limit: 10 }).success).toBe(false);
    expect(IPC['playlists:get'].request.safeParse({ playlistId: 'p1', file: 'x.m3u8' }).success).toBe(false);
    expect(IPC['playlists:delete'].request.safeParse({ playlistId: 'C:\\x' }).success).toBe(false);
    expect(IPC['playlists:create'].request.safeParse({ name: 'line\nbreak' }).success).toBe(false);
    expect(IPC['playlists:create'].request.safeParse({ name: '' }).success).toBe(false);
    expect(IPC['playlists:add'].request.parse({ playlistId: 'p1', tracks: [TRACK] })).toMatchObject({ allowDuplicates: false });
    expect(IPC['playlists:add'].request.safeParse({ playlistId: 'p1', tracks: [] }).success).toBe(false);
    expect(IPC['playlists:move'].request.safeParse({ playlistId: 'p1', entryId: 'e1', to: -1 }).success).toBe(false);
    expect(IPC['playlists:remove'].request.safeParse({ playlistId: 'p1', entryIds: Array.from({ length: 501 }, (_, i) => `e${i}`) }).success).toBe(false);
  });

  it('answer in the shapes the hub serves', () => {
    const summary = FolderPlaylistSummary.parse({ id: 'p1', name: 'Road Trip', fileName: 'Road Trip.m3u8', updatedAt: '2026-10-10T12:00:00.000Z', entryCount: 0, durationSec: 0, origin: 'airwave', readOnly: false });
    expect(IPC['playlists:create'].response.parse({ result: summary, reason: null }).result).toEqual(summary);
    const list = FolderPlaylistList.parse({ folder: { path: 'C:\\Users\\Example\\Music\\Airwave Playlists', isDefault: true, available: true, playlistCount: 1 }, items: [summary] });
    expect(IPC['playlists:list'].response.parse(list)).toEqual(list);
    expect(IPC['playlists:update'].response.parse({ result: null, reason: 'That playlist isn’t in the playlist folder any more.' }).result).toBeNull();
  });
});
