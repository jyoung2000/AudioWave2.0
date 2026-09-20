/**
 * Share links: the access cap also governs streaming, hub tracks can only be shared by a creator
 * that may read the hub library, and only http(s) source links are stored or rendered.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShareItemRow, ShareRecord } from '../../src/db/repositories/shares.js';
import { safeSourceUrl, ShareService } from '../../src/shares/service.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };

const TRACK_ID = '11111111-1111-7111-8111-111111111111';

/**
 * A real artwork row plus the file behind it, so the public artwork route has something to stream.
 * The id shape matters: the library service only resolves `art_` + 32 hex characters.
 */
function insertArtwork(seed = 'a'): string {
  const id = `art_${seed.repeat(32).slice(0, 32)}`;
  // A one-pixel GIF: small, and a real image so the content type is not a fiction.
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  mkdirSync(join(hub.dataDir, 'artwork'), { recursive: true });
  writeFileSync(join(hub.dataDir, 'artwork', `${id}.gif`), bytes);
  hub.ctx.repos.library.putArtwork({ id, mime: 'image/gif', width: 1, height: 1, sizeBytes: bytes.byteLength, relativePath: `${id}.gif` }, new Date(hub.clock.now()).toISOString());
  return id;
}

/** Insert a capped share whose single item is (claimed to be) hub-hosted. */
function insertShare(token: string, maxAccesses: number | null, options: { artworkId?: string | null; expiresAt?: string | null } = {}): string {
  const now = new Date(hub.clock.now()).toISOString();
  const id = `share-${token}`;
  const record: ShareRecord = {
    id,
    kind: 'track',
    targetId: TRACK_ID,
    title: 'Capped',
    description: null,
    ownerId: 'admin',
    ownerDisplayName: 'Admin',
    tokenHash: ShareService.hashToken(token),
    tokenHint: token.slice(-6),
    allowStream: true,
    allowDownload: false,
    expiresAt: options.expiresAt ?? null,
    maxAccesses,
    accessCount: 0,
    playCount: 0,
    createdAt: now,
    revokedAt: null,
  };
  const item: ShareItemRow = { share_id: id, position: 0, track_id: TRACK_ID, title: 'Song', artist_name: 'Artist', album_name: null, duration_ms: null, content_hash: null, open_at_source_url: null, hub_track_id: 'hub-track-1', artwork_id: options.artworkId ?? null };
  hub.ctx.repos.shares.create(record, [item]);
  return id;
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
});

afterEach(async () => {
  await hub.dispose();
});

describe('share stream access cap', () => {
  it('counts a stream without a grant as an access and stops at the cap', () => {
    const id = insertShare('token-capped-aaaaaaaaaaaa', 2);
    expect(hub.ctx.shares.authorizeStream('token-capped-aaaaaaaaaaaa', TRACK_ID).hubTrackId).toBe('hub-track-1');
    expect(hub.ctx.shares.authorizeStream('token-capped-aaaaaaaaaaaa', TRACK_ID, { range: 'bytes=0-' }).hubTrackId).toBe('hub-track-1');
    expect(hub.ctx.repos.shares.find(id)?.accessCount).toBe(2);
    expect(() => hub.ctx.shares.authorizeStream('token-capped-aaaaaaaaaaaa', TRACK_ID)).toThrow(/not available/);
    // Seeking is no way around an exhausted cap either.
    expect(() => hub.ctx.shares.authorizeStream('token-capped-aaaaaaaaaaaa', TRACK_ID, { range: 'bytes=5000-' })).toThrow(/not available/);
  });

  it('lets a counted page view stream and seek with its grant', () => {
    const id = insertShare('token-grant-bbbbbbbbbbbbb', 1);
    const resolved = hub.ctx.shares.resolve('token-grant-bbbbbbbbbbbbb', 'http://localhost');
    expect(resolved.streamGrant).toBeTruthy();
    for (let i = 0; i < 3; i += 1) expect(hub.ctx.shares.authorizeStream('token-grant-bbbbbbbbbbbbb', TRACK_ID, { grant: resolved.streamGrant, range: `bytes=${i * 100}-` }).hubTrackId).toBe('hub-track-1');
    expect(hub.ctx.repos.shares.find(id)?.accessCount).toBe(1);
    // Without the grant the cap is already used up.
    expect(() => hub.ctx.shares.authorizeStream('token-grant-bbbbbbbbbbbbb', TRACK_ID)).toThrow(/not available/);
    // A forged or expired grant is worthless.
    expect(() => hub.ctx.shares.authorizeStream('token-grant-bbbbbbbbbbbbb', TRACK_ID, { grant: `${resolved.streamGrant}x` })).toThrow(/not available/);
    hub.clock.advance(7 * 60 * 60 * 1000);
    expect(() => hub.ctx.shares.authorizeStream('token-grant-bbbbbbbbbbbbb', TRACK_ID, { grant: resolved.streamGrant, range: 'bytes=10-' })).toThrow(/not available/);
  });

  it('puts the grant into the share page stream URLs', async () => {
    insertShare('token-page-ccccccccccccccc', 3);
    const page = await hub.app.inject({ method: 'GET', url: '/s/token-page-ccccccccccccccc' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/data-src="\/api\/v1\/shares\/stream\/token-page-ccccccccccccccc\/[^"?]+\?grant=[^"]+"/);
  });

  it('leaves uncapped links unchanged', () => {
    const id = insertShare('token-free-ddddddddddddddd', null);
    for (let i = 0; i < 5; i += 1) hub.ctx.shares.authorizeStream('token-free-ddddddddddddddd', TRACK_ID);
    expect(hub.ctx.repos.shares.find(id)?.accessCount).toBe(0);
    expect(hub.ctx.shares.resolve('token-free-ddddddddddddddd', 'http://localhost').streamGrant).toBeNull();
  });
});

describe('share creation', () => {
  it('refuses to share hub-hosted tracks for a device without library:read', async () => {
    const device = await pairDevice(hub, admin, { scopes: ['shares:create'] });
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/shares', headers: { authorization: device.authorization }, payload: { kind: 'track', targetId: TRACK_ID, allowStream: true, allowDownload: false, expiresInSeconds: null, maxAccesses: null } });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a non-http source link', async () => {
    const device = await pairDevice(hub, admin);
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
      const response = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/shares',
        headers: { authorization: device.authorization },
        payload: { kind: 'playlist', targetId: 'p', allowStream: false, allowDownload: false, expiresInSeconds: null, maxAccesses: null, items: [{ trackId: TRACK_ID, title: 'x', artistName: 'y', albumName: null, durationMs: null, contentHash: null, openAtSourceUrl: url }] },
      });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('never renders a stored non-http source link', async () => {
    const token = 'token-legacy-eeeeeeeeeeeee';
    const id = insertShare(token, null);
    hub.ctx.db.prepare("UPDATE share_items SET hub_track_id = NULL, open_at_source_url = 'javascript:alert(document.cookie)' WHERE share_id = ?").run(id);
    const page = await hub.app.inject({ method: 'GET', url: `/s/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('javascript:');
    const api = await hub.app.inject({ method: 'GET', url: `/api/v1/shares/resolve/${token}` });
    expect((api.json() as { items: Array<{ openAtSourceUrl: string | null }> }).items[0]?.openAtSourceUrl).toBeNull();
  });

  it('normalises source URLs to http(s) only', () => {
    expect(safeSourceUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeSourceUrl('http://example.com/')).toBe('http://example.com/');
    expect(safeSourceUrl('JAVASCRIPT:alert(1)')).toBeNull();
    expect(safeSourceUrl('https://user:pw@example.com/')).toBeNull();
    expect(safeSourceUrl('not a url')).toBeNull();
  });
});

/**
 * Covers for shared items, which the share page used to request from `/api/v1/library/artwork/:id`
 * — an `admin-or-device` route. Every visitor got 401 and every cover on every share page was a
 * broken image. Nothing caught it because the fixture above never set an `artwork_id`.
 */
describe('public share artwork', () => {
  it('serves a shared cover to an anonymous visitor, and puts that URL on the page', async () => {
    const token = 'token-art-ffffffffffffff';
    const artworkId = insertArtwork('a');
    insertShare(token, null, { artworkId });

    const page = await hub.app.inject({ method: 'GET', url: `/s/${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`/s/${token}/artwork/${artworkId}`);
    // The route that answered 401 must be gone from the page entirely.
    expect(page.body).not.toContain('/api/v1/library/artwork/');

    const image = await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${artworkId}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toMatch(/^image\//);
    expect(image.rawPayload.byteLength).toBeGreaterThan(0);
  });

  it('refuses an artwork id that belongs to no item in the link', async () => {
    const token = 'token-art-foreign-gggggg';
    insertShare(token, null, { artworkId: insertArtwork('a') });
    // A real, readable artwork row — just not one this link shares. Holding one link must not
    // become a reader for every cover in the library.
    const foreign = insertArtwork('b');
    const response = await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${foreign}` });
    expect(response.statusCode).toBe(404);
  });

  it('answers 410 once the link has expired', async () => {
    const token = 'token-art-expired-hhhhhh';
    const artworkId = insertArtwork('a');
    insertShare(token, null, { artworkId, expiresAt: new Date(hub.clock.now() - 1000).toISOString() });
    const response = await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${artworkId}` });
    expect(response.statusCode).toBe(410);
  });

  it('does not spend the link\u2019s access allowance on images', async () => {
    const token = 'token-art-capped-iiiiiii';
    const artworkId = insertArtwork('a');
    const id = insertShare(token, 3, { artworkId });

    const before = hub.ctx.repos.shares.find(id)?.accessCount ?? -1;
    for (let i = 0; i < 5; i += 1) {
      const response = await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${artworkId}` });
      expect(response.statusCode).toBe(200);
    }
    // A page with several covers on it would otherwise exhaust a capped link just by rendering.
    expect(hub.ctx.repos.shares.find(id)?.accessCount).toBe(before);
  });

  it('stops serving covers once the cap is spent', async () => {
    const token = 'token-art-spent-jjjjjjjj';
    const artworkId = insertArtwork('a');
    insertShare(token, 1, { artworkId });
    expect((await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${artworkId}` })).statusCode).toBe(200);
    // One page view spends the only access; the covers on that page still load, later ones do not.
    hub.ctx.shares.resolve(token, 'http://localhost');
    expect((await hub.app.inject({ method: 'GET', url: `/s/${token}/artwork/${artworkId}` })).statusCode).toBe(410);
  });

  it('says nothing about a token it does not know', async () => {
    const response = await hub.app.inject({ method: 'GET', url: `/s/token-never-existed-kkkkk/artwork/${insertArtwork('a')}` });
    expect(response.statusCode).toBe(404);
  });
});
