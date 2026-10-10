/**
 * Library ▸ Playlists and Settings ▸ Playlists in the companion, rendered (DEC-041; CMP-PL-001,
 * CMP-PL-005, CMP-PL-006): the folder's playlists with their mosaics, one opened like an album, songs
 * moved with Alt+↓ and taken out, a long press on touch opening a song's menu, export and delete
 * (asked first), a change on disk read again, and the folder changed only through the system picker,
 * with the playlists moved along. The main process is a fake; nothing touches a disk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlaylistFolderGroup, PlaylistsView } from '../../src/renderer/views/Playlists.js';
import type { CompanionBridge } from '../../src/shared/ipc.js';

type Call = { channel: string; request: Record<string, unknown> };

const COVERS = ['https://cdn-images.dzcdn.net/images/cover/a/250x250.jpg', 'https://cdn-images.dzcdn.net/images/cover/b/250x250.jpg'];
const FOLDER = { path: 'C:\\Users\\Example\\Music\\Airwave Playlists', relativePath: null, isDefault: true, available: true, reason: null, playlistCount: 1, capped: false };
const SUMMARY = { id: 'p1', name: 'Road Trip', fileName: 'Road Trip.m3u8', description: null, createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-10T12:00:00.000Z', entryCount: 2, durationSec: 430, covers: COVERS, origin: 'airwave', readOnly: false, createdBy: 'companion', hasTrack: null };
const entry = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, artist: 'Cassette Bloom', artists: ['Cassette Bloom'], album: null, durationSec: 215, location: `https://www.deezer.com/track/${id}`, locationKind: 'url', trackId: null, catalogId: `deezer:${id}`, isrc: null, artworkUrl: COVERS[0], platforms: ['deezer'], sources: [], addedAt: null, addedBy: 'companion', ...over });
const PAGE = { playlist: SUMMARY, items: [entry('1', 'Harbour Lights', { locationKind: 'library', location: '../Library/Harbour Lights.flac', trackId: 't1' }), entry('2', 'Harbour Wall')], offset: 0, total: 2, hasMore: false };

function installBridge(extra: Record<string, (request: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const answers: Record<string, (request: Record<string, unknown>) => unknown> = {
    'playlists:list': () => ({ folder: FOLDER, items: [SUMMARY] }),
    'playlists:get': () => ({ result: PAGE, reason: null }),
    'playlists:move': () => ({ result: SUMMARY, reason: null }),
    'playlists:remove': () => ({ result: { ...SUMMARY, entryCount: 1 }, reason: null }),
    'playlists:export': () => ({ path: 'C:\\Users\\Example\\Documents\\Road Trip.m3u8', reason: null }),
    'playlists:delete': () => ({ ok: true, reason: null }),
    'playlists:folder': () => FOLDER,
    'playlists:pick-dir': () => ({ folder: { ...FOLDER, path: 'D:\\Music\\Playlists', isDefault: false }, moved: 1, failed: [], reason: null }),
    'playlists:open-folder': () => ({ ok: true, reason: null }),
    ...extra,
  };
  const bridge: CompanionBridge = {
    invoke: (async (channel: string, request: unknown) => {
      calls.push({ channel, request: (request ?? {}) as Record<string, unknown> });
      const answer = answers[channel];
      if (!answer) throw new Error(`No fake for ${channel}`);
      return answer((request ?? {}) as Record<string, unknown>);
    }) as CompanionBridge['invoke'],
    on: ((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    }) as CompanionBridge['on'],
  };
  (window as unknown as { companion?: CompanionBridge }).companion = bridge;
  return { calls, sent: (channel: string) => calls.filter((c) => c.channel === channel), emit: (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => l(payload)) };
}

function said(text: string): boolean {
  return screen.getAllByRole('status').some((s) => s.textContent === text);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { companion?: CompanionBridge }).companion;
});

async function openRoadTrip(): Promise<HTMLElement> {
  const list = await screen.findByRole('listbox', { name: 'Playlists' });
  await userEvent.click(within(list).getByRole('option'));
  const songs = await screen.findByRole('listbox', { name: 'Songs' });
  await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(2));
  return songs;
}

describe('Library ▸ Playlists (CMP-PL-005)', () => {
  it('lists the folder’s playlists with their mosaics, and opens one like an album', async () => {
    installBridge();
    render(<PlaylistsView />);
    const list = await screen.findByRole('listbox', { name: 'Playlists' });
    expect(within(list).getByRole('option').textContent).toBe('Road Trip2 songs · 7 min');
    expect(within(list).getByRole('option').querySelectorAll('.art--mosaic img')).toHaveLength(4);
    expect(screen.getByText('C:\\Users\\Example\\Music\\Airwave Playlists')).toBeTruthy();
    const songs = await openRoadTrip();
    expect(screen.getByRole('heading', { name: 'Road Trip', level: 2 })).toBeTruthy();
    expect(within(songs).getAllByRole('option').map((o) => o.querySelector('.pl-where')!.textContent)).toEqual(['In the library', 'Plays from Deezer']);
  });

  it('moves a song with Alt+↓, takes one out with Delete, exports, and deletes once asked', async () => {
    const bridge = installBridge();
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<PlaylistsView />);
    const songs = await openRoadTrip();
    songs.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(bridge.sent('playlists:move')[0]!.request).toEqual({ playlistId: 'p1', entryId: '1', to: 1 }));
    await waitFor(() => expect(said('Moved “Harbour Lights” to number 2.')).toBe(true));
    songs.focus();
    await userEvent.keyboard('{Home}{Delete}');
    await waitFor(() => expect(bridge.sent('playlists:remove')[0]!.request).toEqual({ playlistId: 'p1', entryIds: ['1'] }));
    await userEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(said('Exported to C:\\Users\\Example\\Documents\\Road Trip.m3u8.')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await waitFor(() => expect(bridge.sent('playlists:delete')[0]!.request).toEqual({ playlistId: 'p1' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Delete “Road Trip”?'));
  });

  it('opens a song’s menu with a long press on touch (CMP-PL-006)', async () => {
    const bridge = installBridge();
    render(<PlaylistsView />);
    const songs = await openRoadTrip();
    const wall = within(songs).getAllByRole('option')[1]!;
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(wall, { pointerType: 'touch', clientX: 30, clientY: 30 });
      act(() => vi.advanceTimersByTime(500));
    } finally {
      vi.useRealTimers();
    }
    const menu = screen.getByRole('menu', { name: '“Harbour Wall”' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Playlist' }));
    await waitFor(() => expect(bridge.sent('playlists:remove')[0]!.request).toEqual({ playlistId: 'p1', entryIds: ['2'] }));
  });

  it('reads the folder again when it changes on disk', async () => {
    const bridge = installBridge();
    render(<PlaylistsView />);
    await screen.findByRole('listbox', { name: 'Playlists' });
    const before = bridge.sent('playlists:list').length;
    act(() => bridge.emit('event:playlists-changed', { at: '2026-10-10T12:00:00.000Z' }));
    await waitFor(() => expect(bridge.sent('playlists:list').length).toBeGreaterThan(before));
  });
});

describe('Settings ▸ Playlists (CMP-PL-001)', () => {
  it('shows the folder, changes it only through the system picker with the playlists moved along, and opens it', async () => {
    const bridge = installBridge();
    const say = vi.fn();
    render(<PlaylistFolderGroup say={say} />);
    expect(await screen.findByText('C:\\Users\\Example\\Music\\Airwave Playlists')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Move my playlists when the folder changes' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Change…' }));
    await waitFor(() => expect(say).toHaveBeenCalledWith('Playlists are kept in D:\\Music\\Playlists now. Moved 1 playlist there.'));
    expect(bridge.sent('playlists:pick-dir')[0]!.request).toEqual({ move: true });
    await userEvent.click(screen.getByRole('button', { name: 'Open Folder' }));
    expect(bridge.sent('playlists:open-folder')).toHaveLength(1);
  });
});
