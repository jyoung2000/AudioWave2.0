/**
 * Profiles, invites people can answer, and backup space — the three route families the player
 * already calls and used to meet with a 404.
 *
 * What is pinned here is what the server decides for itself regardless of the client: a username is
 * unique however two saves race, a picture is whatever its bytes are and is never stored as sent, a
 * shared playlist is never echoed, and an invite addressed to one person works for nobody else.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sniffImage, stripFormulaLead } from '../../src/profiles/service.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const PLAYER_SCOPES = ['library:read', 'search:use', 'group:member', 'group:admin', 'profile:read', 'profile:write', 'backup:read'];
const realFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true }).status === 0;

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let ana: { deviceId: string; authorization: string };
let ben: { deviceId: string; authorization: string };

/** A valid, solid-colour RGB PNG carrying a text chunk, so metadata stripping has something to strip. */
function png(width: number, height: number, text = 'SECRET-META'): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const get = (url: string, who = ana) => hub.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: who.authorization } });
const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, who = ana, contentType?: string) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { authorization: who.authorization, ...(contentType ? { 'content-type': contentType } : {}) }, ...(payload !== undefined ? { payload: payload as string } : {}) });
const asAdmin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({ method, url: `/api/v1${url}`, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

const myId = async (who = ana): Promise<string> => ((await get('/profiles/me', who)).json() as { id: string }).id;

async function useRealFfmpeg(): Promise<void> {
  await hub.dispose();
  hub = await createTestHub({ ffmpeg: { available: true, path: 'ffmpeg', version: 'test', encoders: [] } });
  admin = await hub.completeSetup();
  ana = await pairDevice(hub, admin, { name: 'Ana phone', scopes: PLAYER_SCOPES });
  ben = await pairDevice(hub, admin, { name: 'Ben laptop', scopes: PLAYER_SCOPES });
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  ana = await pairDevice(hub, admin, { name: 'Ana phone', scopes: PLAYER_SCOPES });
  ben = await pairDevice(hub, admin, { name: 'Ben laptop', scopes: PLAYER_SCOPES });
});

afterEach(async () => {
  await hub.dispose();
});

describe('profile names', () => {
  it('starts from the device name and takes a username', async () => {
    expect((await get('/profiles/me')).json()).toMatchObject({ displayName: 'Ana phone', avatarUrl: null, playlists: [] });
    const saved = await send('PATCH', '/profiles/me', { displayName: 'Ana Lima' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ displayName: 'Ana Lima' });
  });

  it('treats a name that differs only by case or Unicode form as taken, with a 409 problem body', async () => {
    expect((await send('PATCH', '/profiles/me', { displayName: 'Zoë Q' })).statusCode).toBe(200);
    // The same name, upper-cased and with the ë decomposed (e + combining diaeresis).
    const clash = await send('PATCH', '/profiles/me', { displayName: 'ZOË q' }, ben);
    expect(clash.statusCode).toBe(409);
    expect(clash.headers['content-type']).toContain('application/problem+json');
    expect(clash.json()).toMatchObject({ status: 409, code: 'conflict', detail: 'That name is taken' });
    expect((await get(`/profiles/available?name=${encodeURIComponent('zoë q')}`, ben)).json()).toEqual({ available: false });
    // The holder may keep re-saving their own name.
    expect((await get(`/profiles/available?name=${encodeURIComponent('zoë q')}`)).json()).toEqual({ available: true });
    expect((await send('PATCH', '/profiles/me', { displayName: 'Zoë Q' })).statusCode).toBe(200);
  });

  it('lets exactly one of two racing saves win', async () => {
    const results = await Promise.all([send('PATCH', '/profiles/me', { displayName: 'Same Name' }), send('PATCH', '/profiles/me', { displayName: 'same name' }, ben)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('enforces uniqueness in the index, not only in code', () => {
    const users = hub.ctx.db.prepare('SELECT id FROM hub_users ORDER BY created_at').all() as Array<{ id: string }>;
    hub.ctx.db.prepare('UPDATE hub_users SET profile_name_key = ? WHERE id = ?').run('dup', users[0]!.id);
    expect(() => hub.ctx.db.prepare('UPDATE hub_users SET profile_name_key = ? WHERE id = ?').run('dup', users[1]!.id)).toThrow(/UNIQUE/);
  });

  it('refuses reserved and malformed names', async () => {
    expect((await send('PATCH', '/profiles/me', { displayName: 'Admin' })).statusCode).toBe(409);
    expect((await get('/profiles/available?name=admin')).json()).toEqual({ available: false });
    for (const bad of ['ab', '-dash', 'dot.', 'a'.repeat(41), 'semi;colon']) {
      expect((await send('PATCH', '/profiles/me', { displayName: bad })).statusCode, bad).toBe(400);
      expect((await get(`/profiles/available?name=${encodeURIComponent(bad)}`)).json(), bad).toEqual({ available: false });
    }
  });
});

describe('profile pictures', () => {
  it('goes by the bytes, not the Content-Type header', async () => {
    const lie = await send('PUT', '/profiles/me/avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), ana, 'image/png');
    expect(lie.statusCode).toBe(400);
    expect(lie.json()).toMatchObject({ detail: 'The picture must be a PNG, JPEG or WebP image' });
  });

  it('refuses a picture larger than 512 × 512', async () => {
    const big = await send('PUT', '/profiles/me/avatar', png(513, 4), ana, 'image/png');
    expect(big.statusCode).toBe(400);
    expect((big.json() as { detail: string }).detail).toContain('512');
  });

  it('says so, and stores nothing, when the hub cannot re-encode', async () => {
    const r = await send('PUT', '/profiles/me/avatar', png(64, 64), ana, 'image/png');
    expect(r.statusCode).toBe(503);
    expect((await get('/profiles/me')).json()).toMatchObject({ avatarUrl: null });
  });

  it.skipIf(!realFfmpeg)('re-encodes to a 256 × 256 WebP without the metadata, serves it, and removes it', async () => {
    await useRealFfmpeg();
    const put = await send('PUT', '/profiles/me/avatar', png(300, 200), ana, 'image/png');
    expect(put.statusCode, put.body).toBe(200);
    const id = await myId();
    expect((await get('/profiles/me')).json()).toMatchObject({ avatarUrl: `/api/v1/profiles/${id}/avatar` });
    const served = await get(`/profiles/${id}/avatar`, ben);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['cache-control']).toBe('private, max-age=300');
    expect(sniffImage(served.rawPayload)).toEqual({ kind: 'webp', width: 256, height: 256 });
    expect(served.rawPayload.includes(Buffer.from('SECRET-META'))).toBe(false);
    expect((await send('DELETE', '/profiles/me/avatar')).statusCode).toBe(200);
    expect((await get(`/profiles/${id}/avatar`, ben)).statusCode).toBe(404);
  });

  it('recognises all three formats and reads their size', () => {
    expect(sniffImage(png(40, 30))).toEqual({ kind: 'png', width: 40, height: 30 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20, 0x00, 0x30, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
    expect(sniffImage(jpeg)).toEqual({ kind: 'jpeg', width: 48, height: 32 });
    expect(sniffImage(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull();
  });
});

describe('shared playlists', () => {
  const csv = 'title,artist,album,seconds\r\n"Hello, Goodbye","The ""Fab"" Four",Magical,207\r\n=HYPERLINK("http://x"),+cmd,@sum,12\r\n-2+3,ok,ok,5\r\n';

  it('round-trips quoted commas and never serves a formula cell', async () => {
    expect((await send('PUT', '/profiles/me/playlists/pl-1?name=Road%20trip', csv, ana, 'text/csv')).statusCode).toBe(200);
    const id = await myId();
    expect((await get(`/profiles/${id}`, ben)).json()).toMatchObject({ playlists: [{ id: 'pl-1', name: 'Road trip', tracks: 3 }] });
    const served = await get(`/profiles/${id}/playlists/pl-1.csv`, ben);
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = served.body.split('\r\n');
    expect(lines[0]).toBe('title,artist,album,seconds');
    expect(lines[1]).toBe('"Hello, Goodbye","The ""Fab"" Four",Magical,207');
    expect(lines[2]).toBe('"HYPERLINK(""http://x"")",cmd,sum,12');
    expect(lines[3]).toBe('2+3,ok,ok,5');
    for (const line of lines.slice(1)) for (const cell of line.split(',')) expect(cell).not.toMatch(/^"?[=+\-@]/);
  });

  it('strips every leading formula character, however they are stacked', () => {
    expect(stripFormulaLead('=+-@cmd')).toBe('cmd');
    expect(stripFormulaLead(' =1+1')).toBe('1+1');
    expect(stripFormulaLead('Plain - title')).toBe('Plain - title');
  });

  it('refuses the wrong header, too many rows and an unshared playlist', async () => {
    expect((await send('PUT', '/profiles/me/playlists/pl-2?name=x', 'name,who\r\na,b\r\n', ana, 'text/csv')).statusCode).toBe(400);
    const many = 'title,artist,album,seconds\r\n' + 'a,b,c,1\r\n'.repeat(5001);
    expect((await send('PUT', '/profiles/me/playlists/pl-3?name=x', many, ana, 'text/csv')).statusCode).toBe(400);
    expect((await send('PUT', '/profiles/me/playlists/pl-1?name=x', csv, ana, 'text/csv')).statusCode).toBe(200);
    expect((await send('DELETE', '/profiles/me/playlists/pl-1')).statusCode).toBe(200);
    expect((await get(`/profiles/${await myId()}/playlists/pl-1.csv`, ben)).statusCode).toBe(404);
  });
});

describe('finding people', () => {
  it('matches case-insensitively and never returns the caller', async () => {
    await send('PATCH', '/profiles/me', { displayName: 'Ana Lima' });
    await send('PATCH', '/profiles/me', { displayName: 'Anabel' }, ben);
    const found = (await get('/profiles?q=ANA&limit=5')).json() as { items: Array<{ displayName: string }> };
    expect(found.items.map((p) => p.displayName)).toEqual(['Anabel']);
    expect((await get('/profiles?q=%25')).json()).toEqual({ items: [] });
    expect((await get('/profiles?limit=21')).statusCode).toBe(400);
  });

  it('answers 403 without the scope, 401 without a credential, and nothing before setup', async () => {
    const bare = await pairDevice(hub, admin, { name: 'No profile scopes', scopes: ['library:read', 'group:member'] });
    for (const url of ['/profiles/me', '/profiles?q=a', '/profiles/available?name=abc']) expect((await get(url, bare)).statusCode, url).toBe(403);
    expect((await send('PATCH', '/profiles/me', { displayName: 'Whoever' }, bare)).statusCode).toBe(403);
    expect((await send('PUT', '/profiles/me/avatar', png(8, 8), bare, 'image/png')).statusCode).toBe(403);
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/profiles/me' })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/profiles?q=a' })).statusCode).toBe(401);
  });

  it('is closed by the first-run gate', async () => {
    // A credential can outlive a reset to the bootstrap password; the gate has to close on it too.
    vi.spyOn(hub.ctx.auth, 'setupComplete').mockReturnValue(false);
    for (const url of ['/profiles/me', '/profiles?q=a', '/me/invites', '/backup/space']) {
      const gated = await get(url);
      expect(gated.statusCode, url).toBe(403);
      expect(gated.json(), url).toMatchObject({ code: 'setup-required' });
    }
  });

  it('lets the admin list, rename and remove a picture', async () => {
    const id = await myId();
    const list = (await asAdmin('GET', '/admin/profiles')).json() as { items: Array<{ id: string; claimed: boolean }> };
    expect(list.items.find((p) => p.id === id)).toMatchObject({ claimed: false, playlistCount: 0 });
    const renamed = await asAdmin('PATCH', `/admin/profiles/${id}`, { displayName: 'Moderated' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ displayName: 'Moderated', claimed: true });
    expect((await asAdmin('DELETE', `/admin/profiles/${id}/avatar`)).statusCode).toBe(200);
    expect((await get('/admin/profiles')).statusCode).toBe(401);
  });
});

describe('invites people can see, answer and withdraw', () => {
  async function group(): Promise<string> {
    const r = await send('POST', '/groups', { name: 'Kitchen' });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  }
  const invite = async (groupId: string, body: Record<string, unknown> = {}) => (await send('POST', `/groups/${groupId}/invites`, body)).json() as { inviteCode: string; inviteId: string; toProfileId: string | null; expiresAt: string };
  const states = async (groupId: string) => ((await get(`/groups/${groupId}/invites`)).json() as { items: Array<{ inviteId: string; state: string; toName: string | null; usedBy: string | null }> }).items;

  it('shows what a code is for without the member list', async () => {
    const g = await group();
    const made = await invite(g, { role: 'guest' });
    expect(made.toProfileId).toBeNull();
    const preview = await get(`/groups/invites/preview?code=${made.inviteCode}`, ben);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ groupName: 'Kitchen', memberCount: 1, fromName: 'Ana phone', role: 'guest', expiresAt: made.expiresAt });
  });

  it('delivers a directed invite to its addressee only', async () => {
    const g = await group();
    const carol = await pairDevice(hub, admin, { name: 'Carol tablet', scopes: PLAYER_SCOPES });
    const made = await invite(g, { toProfileId: await myId(ben) });
    expect(made.toProfileId).toBe(await myId(ben));
    expect((await get('/me/invites', ben)).json()).toEqual({ items: [{ inviteId: made.inviteId, groupId: g, groupName: 'Kitchen', fromName: 'Ana phone', role: 'member', expiresAt: made.expiresAt }] });
    expect((await get('/me/invites', carol)).json()).toEqual({ items: [] });
    // The code exists, but it is not Carol's to use — by code or by id.
    expect((await send('POST', '/groups/join', { inviteCode: made.inviteCode }, carol)).statusCode).toBe(403);
    expect((await send('POST', `/me/invites/${made.inviteId}/accept`, undefined, carol)).statusCode).toBe(404);
    const accepted = await send('POST', `/me/invites/${made.inviteId}/accept`, undefined, ben);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ id: g, myRole: 'member' });
    expect((await get('/me/invites', ben)).json()).toEqual({ items: [] });
    expect(await states(g)).toMatchObject([{ inviteId: made.inviteId, state: 'used', toName: 'Ben laptop', usedBy: 'Ben laptop' }]);
  });

  it('records a decline', async () => {
    const g = await group();
    const made = await invite(g, { toProfileId: await myId(ben) });
    expect((await send('POST', `/me/invites/${made.inviteId}/decline`, undefined, ben)).statusCode).toBe(200);
    expect((await get('/me/invites', ben)).json()).toEqual({ items: [] });
    expect(await states(g)).toMatchObject([{ state: 'declined' }]);
    expect((await send('POST', '/groups/join', { inviteCode: made.inviteCode }, ben)).statusCode).toBe(403);
  });

  it('stops a withdrawn code working at once', async () => {
    const g = await group();
    const made = await invite(g);
    expect((await send('DELETE', `/groups/${g}/invites/${made.inviteId}`)).statusCode).toBe(200);
    expect((await send('POST', '/groups/join', { inviteCode: made.inviteCode }, ben)).statusCode).toBe(403);
    expect(await states(g)).toMatchObject([{ state: 'withdrawn' }]);
    expect((await send('DELETE', `/groups/${g}/invites/00000000-0000-7000-8000-000000000000`)).statusCode).toBe(404);
  });

  it('previews nothing for a used, expired or withdrawn code', async () => {
    const g = await group();
    const used = await invite(g);
    await send('POST', '/groups/join', { inviteCode: used.inviteCode }, ben);
    const withdrawn = await invite(g);
    await send('DELETE', `/groups/${g}/invites/${withdrawn.inviteId}`);
    const expiring = await invite(g, { ttlSeconds: 60 });
    hub.clock.advance(61_000);
    for (const code of [used.inviteCode, withdrawn.inviteCode, expiring.inviteCode, 'NOSUCHCODE']) expect((await get(`/groups/invites/preview?code=${code}`, ben)).statusCode, code).toBe(404);
    expect((await states(g)).map((i) => i.state).sort()).toEqual(['expired', 'used', 'withdrawn']);
  });

  it('keeps a closed invite for 30 days, then forgets it', async () => {
    const g = await group();
    await invite(g, { ttlSeconds: 60 });
    hub.clock.advance(29 * 24 * 3600 * 1000);
    hub.ctx.groups.maintenance();
    expect(await states(g)).toHaveLength(1);
    hub.clock.advance(2 * 24 * 3600 * 1000);
    hub.ctx.groups.maintenance();
    expect(await states(g)).toHaveLength(0);
  });

  it('writes the four audit actions', async () => {
    const g = await group();
    const benId = await myId(ben);
    const a = await invite(g, { toProfileId: benId });
    await send('POST', `/me/invites/${a.inviteId}/decline`, undefined, ben);
    const b = await invite(g, { toProfileId: benId });
    await send('POST', `/me/invites/${b.inviteId}/accept`, undefined, ben);
    const c = await invite(g);
    await send('DELETE', `/groups/${g}/invites/${c.inviteId}`);
    const actions = ((await asAdmin('GET', '/security/audit?limit=200')).json() as { items: Array<{ action: string }> }).items.map((e) => e.action);
    for (const action of ['invite.create', 'invite.decline', 'invite.accept', 'invite.withdraw']) expect(actions, action).toContain(action);
  });

  it('answers 403 on every route without its scope', async () => {
    const g = await group();
    const made = await invite(g, { toProfileId: await myId(ben) });
    const noAdmin = await pairDevice(hub, admin, { name: 'Member only', scopes: ['group:member'] });
    const noMember = await pairDevice(hub, admin, { name: 'No groups', scopes: ['library:read'] });
    expect((await get(`/groups/${g}/invites`, noAdmin)).statusCode).toBe(403);
    expect((await send('DELETE', `/groups/${g}/invites/${made.inviteId}`, undefined, noAdmin)).statusCode).toBe(403);
    expect((await send('POST', `/groups/${g}/invites`, {}, noAdmin)).statusCode).toBe(403);
    expect((await get(`/groups/invites/preview?code=${made.inviteCode}`, noMember)).statusCode).toBe(403);
    expect((await get('/me/invites', noMember)).statusCode).toBe(403);
    expect((await send('POST', `/me/invites/${made.inviteId}/accept`, undefined, noMember)).statusCode).toBe(403);
    expect((await send('POST', `/me/invites/${made.inviteId}/decline`, undefined, noMember)).statusCode).toBe(403);
    // Holding group:admin as a scope is not the same as being this group's admin.
    expect((await get(`/groups/${g}/invites`, ben)).statusCode).toBe(403);
  });
});

describe('backup space', () => {
  it('gives the admin real numbers and the newest archive size', async () => {
    const before = (await asAdmin('GET', '/backup/space')).json() as { path: string; freeBytes: number; totalBytes: number; lastArchiveBytes: number | null; keep: number };
    expect(before.path).toBe(join(hub.ctx.config.dataDir, 'backups'));
    expect(before.freeBytes).toBeGreaterThan(0);
    expect(before.totalBytes).toBeGreaterThanOrEqual(before.freeBytes);
    expect(before.lastArchiveBytes).toBeNull();
    const made = (await asAdmin('POST', '/backup')).json() as { sizeBytes: number };
    expect((await asAdmin('GET', '/backup/space')).json()).toMatchObject({ lastArchiveBytes: made.sizeBytes, keep: 10 });
  });

  it('needs backup:read from a device', async () => {
    expect((await get('/backup/space')).statusCode).toBe(200);
    const bare = await pairDevice(hub, admin, { name: 'No backup scope', scopes: ['library:read'] });
    expect((await get('/backup/space', bare)).statusCode).toBe(403);
  });

  it('never shows a device a host path outside the data volume', async () => {
    const outside = join(hub.ctx.config.dataDir, '..', `np-host-backups-${process.pid}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'backup-20260101T000000Z.sqlite'), 'x'.repeat(10));
    try {
      (hub.ctx.config as { backupDir: string | null }).backupDir = outside;
      expect((await get('/backup/space')).json()).toMatchObject({ path: 'host folder', lastArchiveBytes: 10 });
      expect(((await asAdmin('GET', '/backup/space')).json() as { path: string }).path).toBe(outside);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a missing directory as unknown, not as a failure', async () => {
    (hub.ctx.config as { backupDir: string | null }).backupDir = join(hub.ctx.config.dataDir, 'not', 'there');
    const r = await asAdmin('GET', '/backup/space');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ freeBytes: null, totalBytes: null, lastArchiveBytes: null });
  });
});
