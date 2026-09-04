/**
 * Flows 6–8: shareable links, companion sync and device-to-device transfers.
 *
 * The share tests check the promises made to whoever opens the link: revocation works, expiry
 * works, an access cap cannot be exceeded, the token is never stored, and a link that shares
 * metadata for content the hub does not host says so instead of offering a play button that fails.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let device: { deviceId: string; authorization: string };

const ITEMS = [
  { trackId: '11111111-1111-7111-8111-111111111111', title: 'Ember Line', artistName: 'Test Artist', albumName: 'Test Album', durationMs: 180_000, contentHash: null, openAtSourceUrl: 'https://example.com/track/1' },
  { trackId: '22222222-2222-7222-8222-222222222222', title: 'Second Song', artistName: 'Test Artist', albumName: 'Test Album', durationMs: 200_000, contentHash: null, openAtSourceUrl: null },
];

async function createShare(overrides: Record<string, unknown> = {}): Promise<{ token: string; shareId: string }> {
  const response = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/shares',
    headers: { authorization: device.authorization },
    payload: { kind: 'playlist', targetId: 'my-playlist', title: 'Evening', allowStream: true, allowDownload: false, expiresInSeconds: null, maxAccesses: null, items: ITEMS, ...overrides },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { token: string; share: { id: string } };
  return { token: body.token, shareId: body.share.id };
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
});

afterEach(async () => {
  await hub.dispose();
});

describe('share links', () => {
  it('returns the token exactly once and never stores it', async () => {
    const { token, shareId } = await createShare();
    expect(token.length).toBeGreaterThanOrEqual(24);

    const list = await hub.app.inject({ method: 'GET', url: '/api/v1/shares', headers: { authorization: device.authorization } });
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('tokenHash');
    expect(list.json()).toMatchObject({ items: [expect.objectContaining({ id: shareId, url: null })] });

    // Only the hash is on disk.
    const row = hub.ctx.repos.shares.find(shareId);
    expect(row?.tokenHash).toBe(createHash('sha256').update(`share:${token}`).digest('hex'));
    expect(row?.tokenHash).not.toContain(token);
  });

  it('resolves publicly without any credential and reports honest per-item availability', async () => {
    const { token } = await createShare();
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { items: Array<{ streamable: boolean; openAtSourceUrl: string | null; availabilityNote: string | null }>; totalItems: number };
    expect(payload.totalItems).toBe(2);
    // The hub hosts neither track, so neither is streamable and each says why.
    for (const item of payload.items) {
      expect(item.streamable).toBe(false);
      expect(item.availabilityNote).toBeTruthy();
    }
    expect(payload.items[0]?.openAtSourceUrl).toBe('https://example.com/track/1');
  });

  it('refuses to enable downloads for content the hub does not host', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/shares',
      headers: { authorization: device.authorization },
      payload: { kind: 'playlist', targetId: 'p', allowStream: true, allowDownload: true, expiresInSeconds: null, maxAccesses: null, items: ITEMS },
    });
    expect(response.statusCode).toBe(201);
    // Asking for downloads does not grant them when there are no bytes to serve.
    expect(response.json()).toMatchObject({ share: { allowDownload: false } });
  });

  it('refuses to stream a track the hub does not host', async () => {
    const { token } = await createShare();
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/shares/stream/${token}/${ITEMS[0]!.trackId}` });
    expect(response.statusCode).toBe(422);
    expect(String((response.json() as { detail: string }).detail)).toContain('does not host');
  });

  it('stops working the moment it is revoked, and says nothing about why', async () => {
    const { token, shareId } = await createShare();
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(200);

    await hub.app.inject({ method: 'DELETE', url: `/api/v1/shares/${shareId}`, headers: { authorization: device.authorization } });
    const after = await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` });
    expect(after.statusCode).toBe(404);
    // Revoked, expired and never-existed are indistinguishable to a prober: same status, same
    // body apart from the per-request correlation id.
    const nonsense = await hub.app.inject({ method: 'GET', url: '/api/v1/shares/resolve/aaaaaaaaaaaaaaaaaaaa' });
    const strip = (body: Record<string, unknown>): Record<string, unknown> => {
      const { correlationId: _c, ...rest } = body;
      return rest;
    };
    expect(strip(after.json() as Record<string, unknown>)).toEqual(strip(nonsense.json() as Record<string, unknown>));
  });

  it('expires on schedule', async () => {
    const { token } = await createShare({ expiresInSeconds: 3600 });
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(200);
    hub.clock.advance(3_600_001);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(404);
  });

  it('enforces an access cap exactly', async () => {
    const { token } = await createShare({ maxAccesses: 2 });
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` })).statusCode).toBe(404);
  });

  it('serves a share page that loads nothing from outside the hub', async () => {
    const { token } = await createShare();
    const response = await hub.app.inject({ method: 'GET', url: `/s/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("media-src 'self'");
    expect(response.body).toContain('Ember Line');
    // No external origin anywhere in the markup.
    expect(response.body).not.toMatch(/src="https?:\/\/(?!example\.com\/track)/);
    expect(response.body).toContain('Open at source');
  });

  it('escapes hostile metadata rather than rendering it', async () => {
    await hub.app.inject({
      method: 'POST',
      url: '/api/v1/shares',
      headers: { authorization: device.authorization },
      payload: {
        kind: 'playlist',
        targetId: 'xss',
        title: '<script>alert(1)</script>',
        allowStream: true,
        allowDownload: false,
        expiresInSeconds: null,
        maxAccesses: null,
        items: [{ trackId: '33333333-3333-7333-8333-333333333333', title: '"><img src=x onerror=alert(1)>', artistName: 'A', albumName: null, durationMs: null, contentHash: null, openAtSourceUrl: null }],
      },
    });
    const list = await hub.app.inject({ method: 'GET', url: '/api/v1/shares', headers: { authorization: device.authorization } });
    const shares = (list.json() as { items: Array<{ id: string; title: string }> }).items;
    expect(shares.some((s) => s.title.includes('<script>'))).toBe(true);
    // The title survives verbatim in the API (it is data), but the page must not execute it.
    const create = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/shares',
      headers: { authorization: device.authorization },
      payload: { kind: 'playlist', targetId: 'xss2', title: '<script>alert(2)</script>', allowStream: true, allowDownload: false, expiresInSeconds: null, maxAccesses: null, items: ITEMS },
    });
    const token = (create.json() as { token: string }).token;
    const page = await hub.app.inject({ method: 'GET', url: `/s/${token}` });
    expect(page.body).not.toContain('<script>alert(2)</script>');
    expect(page.body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('does not let one device revoke another deviceial link', async () => {
    const { shareId } = await createShare();
    const other = await pairDevice(hub, admin, { name: 'Other' });
    const response = await hub.app.inject({ method: 'DELETE', url: `/api/v1/shares/${shareId}`, headers: { authorization: other.authorization } });
    expect(response.statusCode).toBe(404);
  });
});

describe('companion sync', () => {
  const manifest = (deviceId: string, collections: Array<{ collection: string; count: number; maxUpdatedAt: string | null; digest: string }>) => ({
    schemaVersion: 1,
    deviceId,
    generatedAt: '2026-01-01T00:00:00.000Z',
    protocolVersion: 1,
    collections,
  });

  it('reports which collections differ', async () => {
    const empty = createHash('sha256').update('').digest('hex');
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/sync/manifest',
      headers: { authorization: device.authorization },
      payload: manifest(device.deviceId, [{ collection: 'playlists', count: 1, maxUpdatedAt: '2026-01-01T00:00:00.000Z', digest: 'a'.repeat(64) }, { collection: 'eqPresets', count: 0, maxUpdatedAt: null, digest: empty }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { needed: string[]; serverManifest: { collections: Array<{ collection: string }> } };
    // The hub holds no playlists, so its digest differs and that collection needs a delta.
    expect(body.needed).toContain('playlists');
    // Both sides are empty for presets, so their digests match and nothing is needed.
    expect(body.needed).not.toContain('eqPresets');
  });

  it('applies a pushed change once, and treats a replay as a duplicate', async () => {
    const change = {
      collection: 'playlists',
      id: '44444444-4444-7444-8444-444444444444',
      updatedAt: '2026-01-02T00:00:00.000Z',
      deleted: false,
      body: { name: 'Evening', trackIds: [] },
      changeId: '55555555-5555-7555-8555-555555555555',
    };
    const payload = { deviceId: device.deviceId, since: {}, changes: [change], enabledCollections: ['playlists'] };

    const first = await hub.app.inject({ method: 'POST', url: '/api/v1/sync/delta', headers: { authorization: device.authorization }, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ applied: 1, duplicates: 0 });

    const second = await hub.app.inject({ method: 'POST', url: '/api/v1/sync/delta', headers: { authorization: device.authorization }, payload });
    expect(second.json()).toMatchObject({ applied: 0, duplicates: 1 });
  });

  it('rejects a change carrying a filesystem path', async () => {
    const payload = {
      deviceId: device.deviceId,
      since: {},
      changes: [{ collection: 'tracks', id: '66666666-6666-7666-8666-666666666666', updatedAt: '2026-01-02T00:00:00.000Z', deleted: false, body: { title: 'Leaky', absolutePath: 'C:/Users/alex/Music/song.flac' }, changeId: '77777777-7777-7777-8777-777777777777' }],
      enabledCollections: ['tracks'],
    };
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/sync/delta', headers: { authorization: device.authorization }, payload });
    expect(response.statusCode).toBe(200);
    // The change is dropped, not stored: a device's own paths never reach the hub.
    expect(response.json()).toMatchObject({ applied: 0 });
    expect(hub.ctx.repos.sync.get('tracks', '66666666-6666-7666-8666-666666666666')).toBeUndefined();
  });

  it('refuses a delta that claims to be from another device', async () => {
    const other = await pairDevice(hub, admin, { name: 'Other' });
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/sync/delta',
      headers: { authorization: device.authorization },
      payload: { deviceId: other.deviceId, since: {}, changes: [], enabledCollections: ['playlists'] },
    });
    expect(response.statusCode).toBe(403);
  });

  it('reports sync status for the calling device', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/sync/status', headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deviceId: device.deviceId, paused: false, pendingLocal: 0 });
  });
});

describe('file transfers', () => {
  const CONTENT = Buffer.from('fake audio bytes for a transfer test');
  const HASH = createHash('sha256').update(CONTENT).digest('hex');

  it('carries a file between two devices, verified by content hash', async () => {
    const receiver = await pairDevice(hub, admin, { name: 'Receiver' });

    const created = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { authorization: device.authorization },
      payload: { toDeviceId: receiver.deviceId, contentHash: HASH, sizeBytes: CONTENT.byteLength, policy: 'both' },
    });
    expect(created.statusCode).toBe(201);

    const head = await hub.app.inject({ method: 'HEAD', url: `/api/v1/files/${HASH}`, headers: { authorization: device.authorization } });
    expect(head.statusCode).toBe(404);
    expect(head.headers['x-received-bytes']).toBe('0');

    const put = await hub.app.inject({
      method: 'PUT',
      url: `/api/v1/files/${HASH}?offset=0&total=${CONTENT.byteLength}`,
      headers: { authorization: device.authorization, 'content-type': 'application/octet-stream' },
      payload: CONTENT,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ complete: true, verified: true, receivedBytes: CONTENT.byteLength });

    const get = await hub.app.inject({ method: 'GET', url: `/api/v1/files/${HASH}`, headers: { authorization: receiver.authorization } });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.equals(CONTENT)).toBe(true);
  });

  it('discards an upload whose bytes do not match the hash it claims', async () => {
    const receiver = await pairDevice(hub, admin, { name: 'Receiver' });
    const lie = createHash('sha256').update('something else entirely').digest('hex');
    await hub.app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { authorization: device.authorization },
      payload: { toDeviceId: receiver.deviceId, contentHash: lie, sizeBytes: CONTENT.byteLength, policy: 'both' },
    });
    const put = await hub.app.inject({
      method: 'PUT',
      url: `/api/v1/files/${lie}?offset=0&total=${CONTENT.byteLength}`,
      headers: { authorization: device.authorization, 'content-type': 'application/octet-stream' },
      payload: CONTENT,
    });
    expect(put.statusCode).toBe(400);
    expect(String((put.json() as { detail: string }).detail)).toContain('do not match');
    // Nothing was kept under the claimed hash.
    const get = await hub.app.inject({ method: 'GET', url: `/api/v1/files/${lie}`, headers: { authorization: receiver.authorization } });
    expect(get.statusCode).toBe(404);
  });

  it('refuses a file to a device no transfer names', async () => {
    const receiver = await pairDevice(hub, admin, { name: 'Receiver' });
    const stranger = await pairDevice(hub, admin, { name: 'Stranger' });
    await hub.app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { authorization: device.authorization },
      payload: { toDeviceId: receiver.deviceId, contentHash: HASH, sizeBytes: CONTENT.byteLength, policy: 'both' },
    });
    await hub.app.inject({
      method: 'PUT',
      url: `/api/v1/files/${HASH}?offset=0&total=${CONTENT.byteLength}`,
      headers: { authorization: device.authorization, 'content-type': 'application/octet-stream' },
      payload: CONTENT,
    });
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/files/${HASH}`, headers: { authorization: stranger.authorization } });
    expect(response.statusCode).toBe(404);
  });

  it('refuses a chunk that does not continue from what the hub holds', async () => {
    const receiver = await pairDevice(hub, admin, { name: 'Receiver' });
    await hub.app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { authorization: device.authorization },
      payload: { toDeviceId: receiver.deviceId, contentHash: HASH, sizeBytes: CONTENT.byteLength, policy: 'both' },
    });
    const response = await hub.app.inject({
      method: 'PUT',
      url: `/api/v1/files/${HASH}?offset=99&total=${CONTENT.byteLength}`,
      headers: { authorization: device.authorization, 'content-type': 'application/octet-stream' },
      payload: CONTENT,
    });
    expect(response.statusCode).toBe(409);
    expect(String((response.json() as { detail: string }).detail)).toContain('Resume from byte 0');
  });
});
