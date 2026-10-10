/**
 * Music ▸ Playlists, rendered (DEC-041; UX-PL-001, UX-PL-006, UX-PL-007): the folder's playlists with
 * their mosaics, one opened like an album, songs moved by the keys and by drag, taken out, the list
 * renamed, exported and deleted (asked first), the folder changed with the offer to move, and the
 * players' shared copies shown apart. Everything goes through a fake hub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HubUiProvider } from '../../src/web/ui.js';
import { PlaylistsView } from '../../src/web/views/Playlists.js';

type Answer = { status?: number; body: unknown };

function fakeHub(routes: Record<string, Answer | ((body: unknown) => Answer)>) {
  const calls: Array<{ method: string; path: string; query: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, 'http://hub.test');
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, query: url.search, body });
      const route = routes[`${method} ${path}`];
      const answer = typeof route === 'function' ? route(body) : (route ?? { status: 404, body: { detail: 'Not found' } });
      const status = answer.status ?? 200;
      return new Response(JSON.stringify(answer.body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
    }),
  );
  return { calls, sent: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

const COVERS = ['https://cdn-images.dzcdn.net/images/cover/a/250x250.jpg', 'https://cdn-images.dzcdn.net/images/cover/b/250x250.jpg', 'https://cdn-images.dzcdn.net/images/cover/c/250x250.jpg', 'https://cdn-images.dzcdn.net/images/cover/d/250x250.jpg'];
const FOLDER = { path: '/data/playlists', relativePath: 'playlists', isDefault: true, available: true, reason: null, playlistCount: 2, capped: false };

function summary(over: Record<string, unknown> = {}) {
  return { id: 'p1', name: 'Road Trip', fileName: 'Road Trip.m3u8', description: null, createdAt: '2026-10-10T12:00:00.000Z', updatedAt: '2026-10-10T12:00:00.000Z', entryCount: 3, durationSec: 655, covers: COVERS, origin: 'airwave', readOnly: false, createdBy: 'admin', hasTrack: null, ...over };
}

function entry(id: string, title: string, over: Record<string, unknown> = {}) {
  return { id, title, artist: 'Cassette Bloom', artists: ['Cassette Bloom'], album: 'Harbour', durationSec: 215, location: `https://www.deezer.com/track/${id}`, locationKind: 'url', trackId: null, catalogId: `deezer:${id}`, isrc: null, artworkUrl: COVERS[0], platforms: ['deezer'], sources: [], addedAt: '2026-10-10T12:00:00.000Z', addedBy: 'admin', ...over };
}

const LIST = {
  'GET /playlists': { body: { folder: FOLDER, items: [summary(), summary({ id: 'm-abc', name: 'Old Favourites', fileName: 'Old Favourites.m3u', origin: 'hand-made', readOnly: true, createdBy: null, covers: [], entryCount: 1, durationSec: 0 })] } },
  'GET /shares/sources': { body: { playlists: [{ id: '0192f0c0-0000-7000-8000-0000000000aa', name: 'Kitchen Mix', trackCount: 12 }], albums: [] } },
};
const PAGE = { playlist: summary(), items: [entry('1', 'Harbour Lights', { locationKind: 'library', location: '../library/music/Harbour Lights.flac', trackId: 't1' }), entry('2', 'Harbour Wall'), entry('3', 'Lost Song', { locationKind: 'missing', location: '../library/gone.mp3' })], offset: 0, total: 3, hasMore: false };

function renderView() {
  return render(
    <HubUiProvider gated={false}>
      {({ sheet, message }) => (
        <>
          <PlaylistsView />
          {sheet}
          <p data-testid="status-strip">{message}</p>
        </>
      )}
    </HubUiProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Music ▸ Playlists (UX-PL-006)', () => {
  it('lists the folder’s playlists with their mosaics and lengths, a hand-made one marked, the folder and the players’ copies apart', async () => {
    fakeHub(LIST);
    renderView();
    const list = await screen.findByRole('listbox', { name: 'Playlists' });
    const rows = await within(list).findAllByRole('option');
    expect(rows.map((r) => r.textContent)).toEqual(['Road Trip3 songs · 11 min', 'Old Favourites1 song · made outside AirwaveHand-made']);
    expect(rows[0]!.querySelectorAll('.art--mosaic img')).toHaveLength(4);
    expect(screen.getByText('/data/playlists', { selector: 'code.pl-folder' })).toBeTruthy();
    const shared = screen.getByRole('list', { name: 'Shared from players' });
    await waitFor(() => expect(shared.textContent).toBe('Kitchen Mix12 songs'));
  });

  it('makes a new playlist from New Playlist…', async () => {
    const hub = fakeHub({ ...LIST, 'POST /playlists': { status: 201, body: summary({ id: 'p9', name: 'Fresh', entryCount: 0 }) } });
    renderView();
    await screen.findAllByRole('option');
    await userEvent.click(screen.getByRole('button', { name: 'New Playlist…' }));
    const sheet = screen.getByRole('dialog', { name: 'New Playlist' });
    await userEvent.type(within(sheet).getByLabelText('Name:'), 'Fresh{Enter}');
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Made “Fresh”. Songs join it from Search: a song’s … ▸ Add to Playlist.'));
    expect(hub.sent('POST', '/playlists')[0]!.body).toEqual({ name: 'Fresh', tracks: [] });
  });
});

describe('a playlist, opened (UX-PL-007)', () => {
  async function openRoadTrip(extra: Record<string, Answer | ((body: unknown) => Answer)> = {}) {
    const hub = fakeHub({ ...LIST, 'GET /playlists/p1': { body: PAGE }, ...extra });
    renderView();
    const list = await screen.findByRole('listbox', { name: 'Playlists' });
    list.focus();
    await userEvent.keyboard('{Enter}');
    const songs = await screen.findByRole('listbox', { name: 'Songs' });
    await waitFor(() => expect(within(songs).getAllByRole('option')).toHaveLength(3));
    return { hub, songs };
  }

  it('opens like an album: the mosaic, the name, the length, and where each song plays from', async () => {
    const { songs } = await openRoadTrip();
    expect(screen.getByRole('heading', { name: 'Road Trip', level: 2 })).toBeTruthy();
    expect(screen.getByText('Playlist · 3 songs · 11 min')).toBeTruthy();
    expect(within(songs).getAllByRole('option').map((o) => o.querySelector('.pl-where')!.textContent)).toEqual(['In the library', 'Plays from Deezer', 'Not found: the file isn’t where the list says']);
    const exported = screen.getByRole('link', { name: 'Export .m3u8' });
    expect(exported.getAttribute('href')).toBe('/api/v1/playlists/p1/export');
    expect(exported.getAttribute('download')).toBe('Road Trip.m3u8');
  });

  it('moves a song with Alt+↓, by drag, and takes one out with Delete', async () => {
    const { hub, songs } = await openRoadTrip({ 'POST /playlists/p1/entries/move': { body: summary() }, 'POST /playlists/p1/entries/remove': { body: summary({ entryCount: 2 }) } });
    songs.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(hub.sent('POST', '/playlists/p1/entries/move')[0]!.body).toEqual({ entryId: '1', to: 1 }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Moved “Harbour Lights” to number 2.'));
    const rows = within(songs).getAllByRole('option');
    fireEvent.dragStart(rows[2]!, { dataTransfer: { setData: () => undefined, effectAllowed: 'move' } });
    fireEvent.dragOver(rows[0]!);
    fireEvent.drop(rows[0]!);
    await waitFor(() => expect(hub.sent('POST', '/playlists/p1/entries/move')[1]!.body).toEqual({ entryId: '3', to: 0 }));
    songs.focus();
    await userEvent.keyboard('{End}{Delete}');
    await waitFor(() => expect(hub.sent('POST', '/playlists/p1/entries/remove')[0]!.body).toEqual({ entryIds: ['3'] }));
  });

  it('its menu moves, opens the link and removes; Shift+F10 opens it', async () => {
    const { hub, songs } = await openRoadTrip({ 'POST /playlists/p1/entries/remove': { body: summary({ entryCount: 2 }) } });
    songs.focus();
    await userEvent.keyboard('{ArrowDown}{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: '“Harbour Wall”' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Move Up', 'Move Down', 'Open Its Link', 'Remove from Playlist']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Remove from Playlist' }));
    await waitFor(() => expect(hub.sent('POST', '/playlists/p1/entries/remove')[0]!.body).toEqual({ entryIds: ['2'] }));
  });

  it('renames, and deletes only once asked', async () => {
    const { hub } = await openRoadTrip({ 'PATCH /playlists/p1': { body: summary({ name: 'Long Drive', fileName: 'Long Drive.m3u8' }) }, 'DELETE /playlists/p1': { body: { ok: true } } });
    await userEvent.click(screen.getByRole('button', { name: 'Rename…' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename “Road Trip”' });
    const field = within(sheet).getByLabelText('Name:');
    await userEvent.clear(field);
    await userEvent.type(field, 'Long Drive');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Renamed to “Long Drive”; its file is Long Drive.m3u8.'));
    expect(hub.sent('PATCH', '/playlists/p1')[0]!.body).toEqual({ name: 'Long Drive' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const ask = screen.getByRole('alertdialog', { name: 'Delete “Road Trip”?' });
    expect(ask.textContent).toContain('The 3 songs stay in the library');
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(hub.sent('DELETE', '/playlists/p1')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(hub.sent('DELETE', '/playlists/p1')).toHaveLength(1));
    expect(await screen.findByRole('listbox', { name: 'Playlists' })).toBeTruthy();
  });
});

describe('the playlist folder (UX-PL-001)', () => {
  it('changes the folder inside the data volume and offers to move the playlists there', async () => {
    const hub = fakeHub({ ...LIST, 'PUT /playlists/folder': { body: { folder: { ...FOLDER, path: '/data/library/Playlists', relativePath: 'library/Playlists', isDefault: false }, moved: 2, failed: [] } } });
    renderView();
    await screen.findAllByRole('option');
    await userEvent.click(screen.getByRole('button', { name: 'Change…' }));
    const sheet = screen.getByRole('dialog', { name: 'Keep playlists somewhere else' });
    expect(sheet.textContent).toContain('Inside /data:');
    const move = within(sheet).getByRole('checkbox', { name: 'Move the 2 playlists there too' }) as HTMLInputElement;
    expect(move.checked).toBe(true);
    const field = within(sheet).getByLabelText('Folder:');
    await userEvent.clear(field);
    await userEvent.type(field, 'library/Playlists');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Use This Folder' }));
    await waitFor(() => expect(screen.getByTestId('status-strip').textContent).toBe('Playlists are kept in /data/library/Playlists now. Moved 2 playlists there.'));
    expect(hub.sent('PUT', '/playlists/folder')[0]!.body).toEqual({ relativePath: 'library/Playlists', move: true });
  });

  it('says why when the server refuses a folder', async () => {
    fakeHub({ ...LIST, 'PUT /playlists/folder': { status: 400, body: { detail: 'Playlists can be kept in a folder inside the hub’s data volume, under /data/playlists or /data/library.' } } });
    renderView();
    await screen.findAllByRole('option');
    await userEvent.click(screen.getByRole('button', { name: 'Change…' }));
    const sheet = screen.getByRole('dialog', { name: 'Keep playlists somewhere else' });
    const field = within(sheet).getByLabelText('Folder:');
    await userEvent.clear(field);
    await userEvent.type(field, '../etc');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Use This Folder' }));
    expect((await within(sheet).findByRole('alert')).textContent).toContain('inside the hub’s data volume');
  });
});
