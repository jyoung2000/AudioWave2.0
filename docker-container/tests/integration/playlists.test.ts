/**
 * The hub's playlist folder through its routes (DEC-041; UX-PL-001…UX-PL-005): the admin's full
 * access, a player filing into hub playlists with `playlists:use`, the folder setting, hand-made
 * lists, export, and starred collections for devices with `library:sync`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderPlaylistList, FolderPlaylistPage, FolderPlaylistSummary } from '@now-playing/contracts';
import { catalogTrack } from '../helpers/catalog-track.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const asAdmin = (method: Method, url: string, payload?: unknown) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const asDevice = (who: { authorization: string }, method: Method, url: string, payload?: unknown) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: who.authorization }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
});

afterEach(async () => {
  await hub.dispose();
});

describe('the hub playlist folder (admin)', () => {
  it('starts empty at <data>/playlists, the default', async () => {
    const list = (await asAdmin('GET', '/playlists')).json() as FolderPlaylistList;
    expect(list.items).toEqual([]);
    expect(list.folder).toMatchObject({ relativePath: 'playlists', isDefault: true, available: true, playlistCount: 0 });
    expect(list.folder.path.endsWith('/playlists')).toBe(true);
    expect(existsSync(join(hub.dataDir, 'playlists'))).toBe(true);
  });

  it('creates, files, ticks, pages, moves, removes, renames, exports and deletes', async () => {
    const created = await asAdmin('POST', '/playlists', { name: 'Road Trip', tracks: [catalogTrack('1', 'One', 'Band')] });
    expect(created.statusCode).toBe(201);
    const made = created.json() as FolderPlaylistSummary;
    expect(made).toMatchObject({ name: 'Road Trip', fileName: 'Road Trip.m3u8', entryCount: 1, createdBy: 'admin' });

    const added = (await asAdmin('POST', `/playlists/${made.id}/entries`, { tracks: [catalogTrack('2', 'Two', 'Band'), catalogTrack('1', 'One', 'Band')] })).json() as { added: number; skipped: number };
    expect(added).toMatchObject({ added: 1, skipped: 1 });

    const ticked = (await asAdmin('GET', '/playlists?catalogId=deezer:2')).json() as FolderPlaylistList;
    expect(ticked.items[0]!.hasTrack).toBe(true);
    expect(((await asAdmin('GET', '/playlists?catalogId=deezer:9')).json() as FolderPlaylistList).items[0]!.hasTrack).toBe(false);

    const page = (await asAdmin('GET', `/playlists/${made.id}?limit=1`)).json() as FolderPlaylistPage;
    expect(page).toMatchObject({ total: 2, hasMore: true, offset: 0 });
    expect(page.items[0]).toMatchObject({ title: 'One', locationKind: 'url', location: 'https://www.deezer.com/track/1', catalogId: 'deezer:1', platforms: ['deezer'] });

    const second = ((await asAdmin('GET', `/playlists/${made.id}?offset=1&limit=1`)).json() as FolderPlaylistPage).items[0]!;
    expect((await asAdmin('POST', `/playlists/${made.id}/entries/move`, { entryId: second.id, to: 0 })).statusCode).toBe(200);
    expect(((await asAdmin('GET', `/playlists/${made.id}`)).json() as FolderPlaylistPage).items.map((e) => e.title)).toEqual(['Two', 'One']);

    expect((await asAdmin('POST', `/playlists/${made.id}/entries/remove`, { entryIds: [second.id] })).json()).toMatchObject({ entryCount: 1 });

    const renamed = (await asAdmin('PATCH', `/playlists/${made.id}`, { name: 'Long Drive', description: 'For the motorway' })).json() as FolderPlaylistSummary;
    expect(renamed).toMatchObject({ id: made.id, name: 'Long Drive', fileName: 'Long Drive.m3u8', description: 'For the motorway' });
    expect(readdirSync(join(hub.dataDir, 'playlists')).sort()).toEqual(['Long Drive.airwave.json', 'Long Drive.m3u8']);

    const exported = await asAdmin('GET', `/playlists/${made.id}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toMatch(/^audio\/x-mpegurl/);
    expect(exported.headers['content-disposition']).toContain('filename="Long Drive.m3u8"');
    expect(exported.body).toBe('#EXTM3U\n#PLAYLIST:Long Drive\n#EXTINF:200,Band - One\nhttps://www.deezer.com/track/1\n');

    expect((await asAdmin('DELETE', `/playlists/${made.id}`)).json()).toEqual({ ok: true });
    expect(readdirSync(join(hub.dataDir, 'playlists'))).toEqual([]);
    expect((await asAdmin('GET', `/playlists/${made.id}`)).statusCode).toBe(404);
  });

  it('files a song the library has as a path relative to the folder, and a player can stream it by id', async () => {
    mkdirSync(join(hub.dataDir, 'library', 'music'), { recursive: true });
    writeFileSync(join(hub.dataDir, 'library', 'music', 'kept.mp3'), 'audio bytes');
    const root = hub.ctx.library.addRoot('music', 'Music', { ip: null, userAgent: null, correlationId: null }, { id: 'admin', displayName: 'Admin' });
    await hub.ctx.library.scanRoot(root.id);
    const [record] = hub.ctx.library.allTracks();
    const song = catalogTrack('7', record!.track.title, record!.track.artistName, { durationMs: null });
    const made = (await asAdmin('POST', '/playlists', { name: 'Local', tracks: [song] })).json() as FolderPlaylistSummary;
    expect(readFileSync(join(hub.dataDir, 'playlists', 'Local.m3u8'), 'utf8')).toContain('\n../library/music/kept.mp3\n');
    const page = (await asAdmin('GET', `/playlists/${made.id}`)).json() as FolderPlaylistPage;
    expect(page.items[0]).toMatchObject({ locationKind: 'library', location: '../library/music/kept.mp3', trackId: record!.id });
  });

  it('shows a hand-made .m3u8 read-only, with its absolute paths hidden', async () => {
    mkdirSync(join(hub.dataDir, 'playlists'), { recursive: true });
    writeFileSync(join(hub.dataDir, 'playlists', 'From Elsewhere.m3u8'), '#EXTM3U\n#EXTINF:90,Someone - Song\nhttps://example.com/song.mp3\n/data/other/secret.mp3\n');
    const list = (await asAdmin('GET', '/playlists')).json() as FolderPlaylistList;
    expect(list.items[0]).toMatchObject({ name: 'From Elsewhere', origin: 'hand-made', readOnly: true, entryCount: 2 });
    const page = (await asAdmin('GET', `/playlists/${list.items[0]!.id}`)).json() as FolderPlaylistPage;
    expect(page.items.map((e) => [e.locationKind, e.location])).toEqual([
      ['url', 'https://example.com/song.mp3'],
      ['missing', null],
    ]);
  });

  it('moves the playlists to a new folder inside the data volume when asked', async () => {
    await asAdmin('POST', '/playlists', { name: 'Keep Me', tracks: [catalogTrack('3', 'Three', 'Band')] });
    const changed = await asAdmin('PUT', '/playlists/folder', { relativePath: 'library/Playlists', move: true });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ moved: 1, failed: [], folder: { relativePath: 'library/Playlists', isDefault: false, playlistCount: 1 } });
    expect(readdirSync(join(hub.dataDir, 'library', 'Playlists')).sort()).toEqual(['Keep Me.airwave.json', 'Keep Me.m3u8']);
    expect(readdirSync(join(hub.dataDir, 'playlists'))).toEqual([]);
    // Typed with the data volume in front, and back without moving: the lists stay where they are.
    const back = await asAdmin('PUT', '/playlists/folder', { relativePath: `${hub.dataDir.replaceAll('\\', '/')}/playlists`, move: false });
    expect(back.json()).toMatchObject({ moved: 0, folder: { relativePath: 'playlists', isDefault: true, playlistCount: 0 } });
  });
});

describe('players filing into hub playlists (playlists:use)', () => {
  it('lets a device read every list, make its own, and file into any', async () => {
    const player = await pairDevice(hub, admin, { name: 'Player', scopes: ['playlists:use'] });
    const adminList = (await asAdmin('POST', '/playlists', { name: 'House' })).json() as FolderPlaylistSummary;
    const listed = (await asDevice(player, 'GET', '/playlists')).json() as FolderPlaylistList;
    expect(listed.items.map((p) => p.name)).toEqual(['House']);
    const filed = await asDevice(player, 'POST', `/playlists/${adminList.id}/entries`, { tracks: [catalogTrack('4', 'Four', 'Band')] });
    expect(filed.statusCode).toBe(200);
    const own = await asDevice(player, 'POST', '/playlists', { name: 'Mine', tracks: [catalogTrack('5', 'Five', 'Band')] });
    expect(own.statusCode).toBe(201);
    expect((own.json() as FolderPlaylistSummary).createdBy).toBe(player.deviceId);
    const sidecar = JSON.parse(readFileSync(join(hub.dataDir, 'playlists', 'House.airwave.json'), 'utf8')) as { entries: Array<{ addedBy: string }> };
    expect(sidecar.entries[0]!.addedBy).toBe(player.deviceId);
  });
});
