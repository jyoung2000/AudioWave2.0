/**
 * The playlist folder's security (DEC-041; docs/SECURITY.md "Playlist folders"): the folder stays
 * inside the data volume, names and ids cannot reach outside it, devices need `playlists:use` and
 * change only what they made or added, the caps hold, and starred collections for devices need
 * `library:sync` and never write the admin's.
 */
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderPlaylistList, FolderPlaylistPage, FolderPlaylistSummary, SavedCollection } from '@now-playing/contracts';
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

describe('the playlist folder stays inside the data volume', () => {
  it.each([['../outside'], ['/etc'], ['C:/Windows'], ['\\\\server\\share'], ['playlists/../../x'], ['playlists/../keys'], ['keys'], ['backups'], ['db'], [''], ['   '], ['playlists/\u0000x'], ['playlists/CON']])('refuses %j and keeps the folder it had', async (relativePath) => {
    const response = await asAdmin('PUT', '/playlists/folder', { relativePath, move: true });
    expect(response.statusCode).toBe(400);
    expect((await asAdmin('GET', '/playlists/folder')).json()).toMatchObject({ relativePath: 'playlists' });
  });

  it('refuses a symbolic link inside the volume that leads out of it', async () => {
    const outside = join(hub.dataDir, '..', `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(hub.dataDir, 'library'), { recursive: true });
    try {
      symlinkSync(outside, join(hub.dataDir, 'library', 'escape'), 'junction');
    } catch {
      return; // No privilege to make a link here: nothing to test.
    }
    const response = await asAdmin('PUT', '/playlists/folder', { relativePath: 'library/escape', move: false });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('outside') });
  });

  it('turns a name into a safe file inside the folder, whatever it says', async () => {
    for (const name of ['../../../etc/passwd', '..\\..\\boot.ini', 'C:\\Windows\\evil', 'NUL', '/data/keys/install.key']) {
      expect((await asAdmin('POST', '/playlists', { name })).statusCode).toBe(201);
    }
    expect(readdirSync(hub.dataDir).sort()).not.toContain('etc');
    const files = readdirSync(join(hub.dataDir, 'playlists'));
    expect(files.every((f) => !f.includes('/') && !f.includes('\\') && !f.startsWith('.'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.m3u8'))).toHaveLength(5);
    // A name with a line break in it is refused outright: it could not be one #PLAYLIST line.
    expect((await asAdmin('POST', '/playlists', { name: 'a\nb' })).statusCode).toBe(400);
  });

  it('refuses an id that is a path', async () => {
    for (const id of ['..%2F..%2Fetc%2Fpasswd', '..', '%2e%2e', 'a%5Cb', 'x.m3u8']) {
      const response = await asAdmin('GET', `/playlists/${id}`);
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('keeps the export’s file name to one header line', async () => {
    const made = (await asAdmin('POST', '/playlists', { name: 'Quote " and; semi' })).json() as FolderPlaylistSummary;
    const exported = await asAdmin('GET', `/playlists/${made.id}/export`);
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''[^\s"]+$/);
  });
});

describe('who may use the hub’s playlists', () => {
  it('needs a signed-in admin or a device with playlists:use', async () => {
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/playlists' })).statusCode).toBe(401);
    const without = await pairDevice(hub, admin, { name: 'No playlists', scopes: ['library:read'] });
    expect((await asDevice(without, 'GET', '/playlists')).statusCode).toBe(403);
    expect((await asDevice(without, 'POST', '/playlists', { name: 'x' })).statusCode).toBe(403);
    // The folder is the admin's alone.
    const withScope = await pairDevice(hub, admin, { name: 'Player', scopes: ['playlists:use'] });
    expect((await asDevice(withScope, 'GET', '/playlists/folder')).statusCode).toBe(401);
    expect((await asDevice(withScope, 'PUT', '/playlists/folder', { relativePath: 'library/x' })).statusCode).toBe(401);
  });

  it('asks the admin for the CSRF token on every change', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/playlists', headers: { cookie: admin.cookie }, payload: { name: 'x' } });
    expect(response.statusCode).toBe(403);
  });

  it('lets a device change only what it made, and remove only what it added', async () => {
    const one = await pairDevice(hub, admin, { name: 'One', scopes: ['playlists:use'] });
    const two = await pairDevice(hub, admin, { name: 'Two', scopes: ['playlists:use'] });
    const house = (await asAdmin('POST', '/playlists', { name: 'House', tracks: [catalogTrack('1', 'One', 'Band')] })).json() as FolderPlaylistSummary;
    await asDevice(one, 'POST', `/playlists/${house.id}/entries`, { tracks: [catalogTrack('2', 'Two', 'Band')] });
    const entries = ((await asDevice(one, 'GET', `/playlists/${house.id}`)).json() as FolderPlaylistPage).items;
    const adminsEntry = entries.find((e) => e.addedBy === 'admin')!;
    const onesEntry = entries.find((e) => e.addedBy === one.deviceId)!;

    expect((await asDevice(one, 'PATCH', `/playlists/${house.id}`, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await asDevice(one, 'DELETE', `/playlists/${house.id}`)).statusCode).toBe(403);
    expect((await asDevice(one, 'POST', `/playlists/${house.id}/entries/move`, { entryId: onesEntry.id, to: 0 })).statusCode).toBe(403);
    expect((await asDevice(one, 'POST', `/playlists/${house.id}/entries/remove`, { entryIds: [adminsEntry.id] })).statusCode).toBe(403);
    expect((await asDevice(two, 'POST', `/playlists/${house.id}/entries/remove`, { entryIds: [onesEntry.id] })).statusCode).toBe(403);
    expect((await asDevice(one, 'POST', `/playlists/${house.id}/entries/remove`, { entryIds: [onesEntry.id] })).statusCode).toBe(200);

    const mine = (await asDevice(two, 'POST', '/playlists', { name: 'Two’s' })).json() as FolderPlaylistSummary;
    expect((await asDevice(two, 'PATCH', `/playlists/${mine.id}`, { name: 'Two’s mix' })).statusCode).toBe(200);
    expect((await asDevice(one, 'DELETE', `/playlists/${mine.id}`)).statusCode).toBe(403);
    expect((await asDevice(two, 'DELETE', `/playlists/${mine.id}`)).statusCode).toBe(200);
    // The admin may do anything.
    expect((await asAdmin('POST', `/playlists/${house.id}/entries/remove`, { entryIds: [adminsEntry.id] })).statusCode).toBe(200);
  });
});

describe('the caps', () => {
  it('holds a playlist to 10,000 songs', async () => {
    mkdirSync(join(hub.dataDir, 'playlists'), { recursive: true });
    const lines = Array.from({ length: 10_000 }, (_, i) => `https://example.com/${i}.mp3`).join('\n');
    writeFileSync(join(hub.dataDir, 'playlists', 'Full.m3u8'), `#EXTM3U\n${lines}\n`);
    const [full] = ((await asAdmin('GET', '/playlists')).json() as FolderPlaylistList).items;
    expect(full!.entryCount).toBe(10_000);
    const response = await asAdmin('POST', `/playlists/${full!.id}/entries`, { tracks: [catalogTrack('9', 'Nine', 'Band')] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('10,000') });
  });

  it('holds a request to 500 songs and a folder to 1,000 playlists', async () => {
    const many = Array.from({ length: 501 }, (_, i) => catalogTrack(String(i), `S${i}`, 'B'));
    expect((await asAdmin('POST', '/playlists', { name: 'Too many', tracks: many })).statusCode).toBe(400);
    mkdirSync(join(hub.dataDir, 'playlists'), { recursive: true });
    for (let i = 0; i < 1_000; i++) writeFileSync(join(hub.dataDir, 'playlists', `p${i}.m3u`), '#EXTM3U\n');
    const response = await asAdmin('POST', '/playlists', { name: 'One more' });
    expect(response.statusCode).toBe(409);
  });
});

describe('starred collections for devices (library:sync)', () => {
  const star = (id: string, title: string): SavedCollection => ({
    ref: { platform: 'deezer', kind: 'playlist', id, url: `https://www.deezer.com/playlist/${id}`, title, owner: null },
    savedAt: '2026-10-10T12:00:00.000Z',
    artworkUrl: null,
    covers: [],
    trackCount: 10,
  });

  it('needs library:sync, keeps each device’s own, and shows the admin’s as shared, read-only', async () => {
    expect((await asAdmin('PUT', '/catalog/saved', star('1', 'Admin’s'))).statusCode).toBe(200);
    const without = await pairDevice(hub, admin, { name: 'No sync', scopes: ['search:use'] });
    expect((await asDevice(without, 'GET', '/catalog/saved')).statusCode).toBe(403);

    const player = await pairDevice(hub, admin, { name: 'Player', scopes: ['library:sync'] });
    const other = await pairDevice(hub, admin, { name: 'Other', scopes: ['library:sync'] });
    expect((await asDevice(player, 'GET', '/catalog/saved')).json()).toMatchObject({ items: [], shared: [{ ref: { id: '1' } }] });
    const put = (await asDevice(player, 'PUT', '/catalog/saved', star('2', 'Player’s'))).json() as { items: SavedCollection[] };
    expect(put.items.map((s) => s.ref.id)).toEqual(['2']);
    expect(((await asDevice(other, 'GET', '/catalog/saved')).json() as { items: SavedCollection[] }).items).toEqual([]);
    // Un-starring the admin's from a device removes nothing of the admin's.
    await asDevice(player, 'DELETE', '/catalog/saved?platform=deezer&kind=playlist&id=1');
    expect(((await asAdmin('GET', '/catalog/saved')).json() as { items: SavedCollection[] }).items.map((s) => s.ref.id)).toEqual(['1']);
  });
});
