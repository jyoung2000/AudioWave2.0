/**
 * The admin window's controls that used to have nothing behind them: backup settings, schedule,
 * Keep and Include; downloading one archive; scanning one folder; making a shared link from the
 * hub's own playlists and albums; and the copy of a companion's Live TV the hub keeps for players.
 *
 * What is pinned is what the server decides whatever the client sends: a backup folder never leaves
 * the data volume, a download only ever serves an archive the hub lists, Live TV is accepted only
 * from a paired companion with `library:share`, holds only plain web links, and is read only with
 * `library:read`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextScheduledRun } from '../../src/backup/schedule.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };

const asAdmin = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
const asDevice = (who: { authorization: string }, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: who.authorization }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
});

afterEach(async () => {
  await hub.dispose();
});

describe('backup settings', () => {
  it('start as the hub always behaved: every night, everything included, the last 10 kept', async () => {
    const view = (await asAdmin('GET', '/backup/settings')).json() as Record<string, unknown>;
    expect(view).toMatchObject({ location: 'backups', include: { credentials: true, activity: true, caches: true }, schedule: { frequency: 'daily', time: '03:00' }, keep: 10, locationFixed: false });
    expect(view['path']).toBe(join(hub.dataDir, 'backups'));
    expect(typeof view['nextRunAt']).toBe('string');
  });

  it('accept a folder inside the data volume, typed either way, and write backups there', async () => {
    const saved = await asAdmin('PUT', '/backup/settings', { location: `${hub.dataDir.replaceAll('\\', '/')}/archive/hub` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ location: 'archive/hub', path: join(hub.dataDir, 'archive', 'hub') });
    const made = (await asAdmin('POST', '/backup')).json() as { relativePath: string };
    expect(made.relativePath).toMatch(/^archive\/hub\/backup-\d{8}T\d{6}Z\.sqlite$/);
    expect(existsSync(join(hub.dataDir, made.relativePath))).toBe(true);
    expect((await asAdmin('PUT', '/backup/settings', { location: 'other' })).json()).toMatchObject({ location: 'other' });
  });

  it.each([['../outside'], ['/etc'], ['C:/Windows'], ['backups/../../x'], ['keys'], ['keys/sub'], [''], ['   ']])('refuse %j and keep what was there', async (location) => {
    const response = await asAdmin('PUT', '/backup/settings', { location });
    expect(response.statusCode).toBe(400);
    expect((await asAdmin('GET', '/backup/settings')).json()).toMatchObject({ location: 'backups' });
  });

  it('refuse a bad time, weekday or keep count', async () => {
    expect((await asAdmin('PUT', '/backup/settings', { schedule: { frequency: 'daily', time: '25:00', weekday: 0 } })).statusCode).toBe(400);
    expect((await asAdmin('PUT', '/backup/settings', { schedule: { frequency: 'weekly', time: '03:00', weekday: 7 } })).statusCode).toBe(400);
    expect((await asAdmin('PUT', '/backup/settings', { keep: -1 })).statusCode).toBe(400);
  });

  it('cannot be changed by a device, nor without the CSRF token', async () => {
    const device = await pairDevice(hub, admin, { name: 'Player', scopes: ['library:read', 'backup:read'] });
    expect((await asDevice(device, 'PUT', '/backup/settings', { keep: 1 })).statusCode).toBe(401);
    const noCsrf = await hub.app.inject({ method: 'PUT', url: '/api/v1/backup/settings', headers: { cookie: admin.cookie }, payload: { keep: 1 } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('leave out the parts that are switched off, from the archive only', async () => {
    hub.ctx.repos.settings.set('discord.token', 'sealed-token', new Date(hub.clock.now()).toISOString());
    await asAdmin('PUT', '/backup/settings', { include: { credentials: false, activity: false, caches: true } });
    const made = (await asAdmin('POST', '/backup')).json() as { relativePath: string };
    const archive = new Database(join(hub.dataDir, made.relativePath), { readonly: true });
    try {
      expect(archive.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'discord.token'").get()).toEqual({ n: 0 });
      expect(archive.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
      // Everything else is there: the settings themselves, for one.
      expect((archive.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'backup.settings'").get() as { n: number }).n).toBe(1);
    } finally {
      archive.close();
    }
    // The live hub still has what the archive left out.
    expect(hub.ctx.repos.settings.get('discord.token')).toBe('sealed-token');
  });

  it('take a scheduled backup when its slot comes, and keep only the last N', async () => {
    await asAdmin('PUT', '/backup/settings', { schedule: { frequency: 'daily', time: '03:00', weekday: 0 }, keep: 2 });
    const first = (await asAdmin('GET', '/backup/settings')).json() as { nextRunAt: string };
    expect(await hub.ctx.backup.runScheduled()).toBeNull();
    for (let day = 0; day < 4; day += 1) {
      // The service itself: a session would expire over these days.
      const next = hub.ctx.backup.settingsView() as { nextRunAt: string };
      hub.clock.advance(Date.parse(next.nextRunAt) - hub.clock.now() + 1000);
      expect(await hub.ctx.backup.runScheduled()).not.toBeNull();
      // Nothing more until the next slot.
      expect(await hub.ctx.backup.runScheduled()).toBeNull();
    }
    const listed = { items: hub.ctx.backup.list() };
    expect(listed.items.filter((b) => b.id.endsWith('-auto'))).toHaveLength(2);
    expect(Date.parse(first.nextRunAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    expect(hub.ctx.backup.settingsView()).toMatchObject({ lastRunAt: expect.any(String) });
  });

  it('never runs when switched off', async () => {
    await asAdmin('PUT', '/backup/settings', { schedule: { frequency: 'off', time: '03:00', weekday: 0 } });
    hub.clock.advance(3 * 86_400_000);
    expect(await hub.ctx.backup.runScheduled()).toBeNull();
    expect(hub.ctx.backup.settingsView()).toMatchObject({ nextRunAt: null });
  });
});

describe('the schedule', () => {
  it('finds the next daily and weekly slot on the hub clock', () => {
    const at = new Date(2026, 0, 7, 12, 0).getTime(); // a Wednesday, noon
    expect(new Date(nextScheduledRun({ frequency: 'daily', time: '03:00', weekday: 0 }, at)!)).toEqual(new Date(2026, 0, 8, 3, 0));
    expect(new Date(nextScheduledRun({ frequency: 'daily', time: '13:30', weekday: 0 }, at)!)).toEqual(new Date(2026, 0, 7, 13, 30));
    expect(new Date(nextScheduledRun({ frequency: 'weekly', time: '03:00', weekday: 0 }, at)!)).toEqual(new Date(2026, 0, 11, 3, 0));
    expect(new Date(nextScheduledRun({ frequency: 'weekly', time: '13:00', weekday: 3 }, at)!)).toEqual(new Date(2026, 0, 7, 13, 0));
    expect(new Date(nextScheduledRun({ frequency: 'weekly', time: '11:00', weekday: 3 }, at)!)).toEqual(new Date(2026, 0, 14, 11, 0));
    expect(nextScheduledRun({ frequency: 'off', time: '03:00', weekday: 0 }, at)).toBeNull();
  });
});

describe('downloading a backup', () => {
  it('streams an archive the hub lists, as an attachment', async () => {
    const made = (await asAdmin('POST', '/backup')).json() as { id: string; sizeBytes: number };
    const response = await asAdmin('GET', `/backup/${made.id}/download`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${made.id}.sqlite"`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.byteLength).toBe(made.sizeBytes);
    expect(response.rawPayload.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });

  it('serves nothing else: not a crafted name, not a file the hub did not write', async () => {
    writeFileSync(join(hub.dataDir, 'backups', 'notes.sqlite'), 'secret');
    mkdirSync(join(hub.dataDir, 'backups', 'x'), { recursive: true });
    for (const id of ['notes', '..%2Fhub', '..%2F..%2Finstall.key', 'backup-20260101T000000Z', '%2e%2e', 'hub']) {
      const response = await asAdmin('GET', `/backup/${id}/download`);
      expect(response.statusCode, id).toBe(404);
    }
  });

  it('is for the admin only', async () => {
    const made = (await asAdmin('POST', '/backup')).json() as { id: string };
    const device = await pairDevice(hub, admin, { name: 'Player', scopes: ['library:read', 'backup:read'] });
    expect((await asDevice(device, 'GET', `/backup/${made.id}/download`)).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/backup/${made.id}/download` })).statusCode).toBe(401);
  });
});

describe('scanning one folder', () => {
  it('queues a scan of that folder alone', async () => {
    mkdirSync(join(hub.dataDir, 'library', 'one'), { recursive: true });
    mkdirSync(join(hub.dataDir, 'library', 'two'), { recursive: true });
    writeFileSync(join(hub.dataDir, 'library', 'one', 'a.mp3'), 'a bytes');
    writeFileSync(join(hub.dataDir, 'library', 'two', 'b.mp3'), 'b bytes');
    const one = (await asAdmin('POST', '/library/roots', { relativePath: 'one', displayName: 'One' })).json() as { id: string };
    const two = (await asAdmin('POST', '/library/roots', { relativePath: 'two', displayName: 'Two' })).json() as { id: string };
    const queued = await asAdmin('POST', `/library/roots/${one.id}/scan`);
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ roots: 1 });
    await hub.ctx.jobs.drain();
    const roots = (await asAdmin('GET', '/library/roots')).json() as { items: Array<{ id: string; trackCount: number; lastScanAt: string | null }> };
    expect(roots.items.find((r) => r.id === one.id)).toMatchObject({ trackCount: 1 });
    expect(roots.items.find((r) => r.id === two.id)).toMatchObject({ trackCount: 0, lastScanAt: null });
  });

  it('says so when the folder is not in the library', async () => {
    expect((await asAdmin('POST', '/library/roots/0192b1f0-0000-7000-8000-000000000009/scan')).statusCode).toBe(404);
  });
});

describe('sharing from the admin window', () => {
  const PLAYLIST = '0192b1f0-0000-7000-8000-0000000000a1';
  const TRACK = '0192b1f0-0000-7000-8000-0000000000b1';

  beforeEach(() => {
    const now = new Date(hub.clock.now()).toISOString();
    hub.ctx.repos.sync.put('playlists', { id: PLAYLIST, updatedAt: now, deletedAt: null, name: 'Late Night', kind: 'user' } as never, '0192b1f0-0000-7000-8000-0000000000c1', 'device-1', 'device-1');
    hub.ctx.repos.sync.put(
      'playlistItems',
      { id: '0192b1f0-0000-7000-8000-0000000000d1', updatedAt: now, deletedAt: null, playlistId: PLAYLIST, position: 0, track: { trackId: TRACK, title: 'Harbour Lights', artistName: 'The Tides', albumName: null, durationMs: 200_000, identity: {}, locators: [] } } as never,
      '0192b1f0-0000-7000-8000-0000000000c2',
      'device-1',
      'device-1',
    );
  });

  it('lists the synced playlists that have tracks', async () => {
    const sources = (await asAdmin('GET', '/shares/sources')).json() as { playlists: Array<{ id: string; name: string; trackCount: number }>; albums: unknown[] };
    expect(sources.playlists).toEqual([{ id: PLAYLIST, name: 'Late Night', trackCount: 1 }]);
    expect(Array.isArray(sources.albums)).toBe(true);
  });

  it('makes a link to a synced playlist, with the link returned once and listed after', async () => {
    const response = await asAdmin('POST', '/shares', { kind: 'playlist', targetId: PLAYLIST, expiresInSeconds: 7 * 86_400 });
    expect(response.statusCode).toBe(201);
    const made = response.json() as { share: { id: string; title: string; expiresAt: string; allowDownload: boolean }; token: string };
    expect(made.share.title).toBe('Late Night');
    expect(made.share.allowDownload).toBe(false);
    expect(made.token.length).toBeGreaterThanOrEqual(16);
    const listed = (await asAdmin('GET', '/shares')).json() as { items: Array<{ id: string; url: string | null }> };
    expect(listed.items.find((s) => s.id === made.share.id)).toMatchObject({ url: null });
    // The item is metadata only: the hub does not hold that file, so the page cannot stream it.
    const resolved = (await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${made.token}` })).json() as { items: Array<{ streamable: boolean }> };
    expect(resolved.items).toHaveLength(1);
    expect(resolved.items[0]!.streamable).toBe(false);
  });

  it('refuses a playlist the hub does not have', async () => {
    expect((await asAdmin('POST', '/shares', { kind: 'playlist', targetId: '0192b1f0-0000-7000-8000-0000000000ff' })).statusCode).toBe(404);
  });

  it('does not let a device make a link to someone else’s synced playlist by id', async () => {
    const device = await pairDevice(hub, admin, { name: 'Player', scopes: ['shares:create'] });
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/shares', headers: { authorization: device.authorization }, payload: { kind: 'playlist', targetId: PLAYLIST } });
    expect(response.statusCode).toBe(400);
    expect((await asDevice(device, 'GET', '/shares/sources')).statusCode).toBe(401);
  });
});

describe('Live TV kept on the hub', () => {
  const channel = (n: number, url = `https://tv.example.com/${n}.m3u8`) => ({ id: `c${n}`, name: `Channel ${n}`, number: n, group: null, logo: null, url, tvgId: `ch${n}` });
  const guide = [{ tvgId: 'ch1', now: { title: 'News', start: '2026-01-01T00:00:00.000Z', stop: '2026-01-01T01:00:00.000Z', description: null }, next: null }];

  it('takes a companion’s channels and hands them to a player', async () => {
    const companion = await pairDevice(hub, admin, { name: 'Living room PC', kind: 'companion', scopes: ['library:share', 'library:read'] });
    const player = await pairDevice(hub, admin, { name: 'Phone', scopes: ['library:read'] });
    const put = await asDevice(companion, 'PUT', '/live-tv', { channels: [channel(1), channel(2)], guide });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ channelCount: 2, guideCount: 1, sourceDevice: { deviceId: companion.deviceId, name: 'Living room PC' } });
    const got = (await asDevice(player, 'GET', '/live-tv')).json() as { channels: unknown[]; guide: unknown[]; updatedAt: string; sourceDevice: { name: string } };
    expect(got.channels).toHaveLength(2);
    expect(got.guide).toEqual(guide);
    expect(got.sourceDevice.name).toBe('Living room PC');
    expect((await asAdmin('GET', '/live-tv/summary')).json()).toMatchObject({ channelCount: 2 });
  });

  it('is empty, not missing, before any companion has sent it', async () => {
    const player = await pairDevice(hub, admin, { name: 'Phone', scopes: ['library:read'] });
    expect((await asDevice(player, 'GET', '/live-tv')).json()).toEqual({ channels: [], guide: [], updatedAt: null, sourceDevice: null });
  });

  it('is accepted only from a companion holding library:share, and read only with library:read', async () => {
    const player = await pairDevice(hub, admin, { name: 'Phone', scopes: ['library:read', 'library:share'] });
    expect((await asDevice(player, 'PUT', '/live-tv', { channels: [channel(1)], guide: [] })).statusCode).toBe(403);
    const noShare = await pairDevice(hub, admin, { name: 'PC', kind: 'companion', scopes: ['library:read'] });
    expect((await asDevice(noShare, 'PUT', '/live-tv', { channels: [channel(1)], guide: [] })).statusCode).toBe(403);
    const noRead = await pairDevice(hub, admin, { name: 'Speaker', scopes: ['search:use'] });
    expect((await asDevice(noRead, 'GET', '/live-tv')).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/live-tv' })).statusCode).toBe(401);
    // The admin's session is not a companion either.
    expect((await asAdmin('PUT', '/live-tv', { channels: [channel(1)], guide: [] })).statusCode).toBe(401);
  });

  it.each([['javascript:alert(1)'], ['file:///etc/passwd'], ['rtmp://tv.example.com/live'], ['https://user:pass@tv.example.com/1'], ['not a url']])('refuses a channel at %s', async (url) => {
    const companion = await pairDevice(hub, admin, { name: 'PC', kind: 'companion', scopes: ['library:share'] });
    expect((await asDevice(companion, 'PUT', '/live-tv', { channels: [channel(1, url)], guide: [] })).statusCode).toBe(400);
    expect((await asDevice(companion, 'PUT', '/live-tv', { channels: [{ ...channel(1), logo: url }], guide: [] })).statusCode).toBe(400);
  });

  it('refuses more than 50,000 channels', async () => {
    const companion = await pairDevice(hub, admin, { name: 'PC', kind: 'companion', scopes: ['library:share'] });
    const many = Array.from({ length: 50_001 }, (_, i) => ({ id: `c${i}`, name: 'C', number: i + 1, group: null, logo: null, url: 'https://t.v/x', tvgId: null }));
    const response = await asDevice(companion, 'PUT', '/live-tv', { channels: many, guide: [] });
    expect(response.statusCode).toBe(400);
  });

  it('can be removed by the admin, or by the companion that sent it but not another', async () => {
    const pc = await pairDevice(hub, admin, { name: 'PC', kind: 'companion', scopes: ['library:share'] });
    const other = await pairDevice(hub, admin, { name: 'Laptop', kind: 'companion', scopes: ['library:share'] });
    await asDevice(pc, 'PUT', '/live-tv', { channels: [channel(1)], guide: [] });
    expect((await asDevice(other, 'DELETE', '/live-tv')).statusCode).toBe(403);
    expect((await asDevice(pc, 'DELETE', '/live-tv')).statusCode).toBe(200);
    expect((await asAdmin('GET', '/live-tv/summary')).json()).toMatchObject({ channelCount: 0, sourceDevice: null });
    await asDevice(pc, 'PUT', '/live-tv', { channels: [channel(1)], guide: [] });
    expect((await asAdmin('DELETE', '/live-tv')).statusCode).toBe(200);
    expect((await asAdmin('GET', '/live-tv/summary')).json()).toMatchObject({ channelCount: 0 });
  });
});
