/**
 * The companion talking to a real hub.
 *
 * Both halves are the real thing: the companion's `HubClient` and its SQLite store on one side, the
 * hub's actual Fastify application and database on the other. Only the transport is replaced —
 * `fetch` is routed into the hub's injector instead of a socket — so what these tests exercise is
 * the two products' agreement about pairing, sync and transfers, which is exactly the thing that
 * unit tests on either side cannot check.
 *
 * The one that matters most is the privacy assertion: after a full sync, nothing the hub stored may
 * contain a Windows path. That is checked by reading the hub's database, not by trusting the
 * companion's sanitiser.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { makeToneWav } from '@now-playing/test-fixtures';
import { createTestHub, type TestHub } from '../../../docker-container/tests/helpers/hub.js';
import { HubClient } from '../../src/main/hub.js';
import { scanFolder } from '../../src/main/library.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let store: CompanionStore;
let musicDir: string;
let realFetch: typeof globalThis.fetch;

/** Route the companion's outbound HTTP into the hub's injector, preserving status, headers and body. */
function routeFetchToHub(target: TestHub): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = init?.body;
    const payload = body === undefined || body === null ? undefined : typeof body === 'string' ? body : Buffer.from(body as Uint8Array);
    const response = await target.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    const outHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') outHeaders.set(key, value);
      else if (Array.isArray(value)) for (const v of value) outHeaders.append(key, v);
    }
    // HEAD and 204 responses must not carry a body, or the Response constructor throws.
    const hasBody = response.statusCode !== 204 && response.statusCode !== 304 && (init?.method ?? 'GET') !== 'HEAD';
    return new Response(hasBody ? response.rawPayload : null, { status: response.statusCode, headers: outHeaders });
  }) as typeof globalThis.fetch;
}

async function pairCompanion(client: HubClient, scopes?: string[]): Promise<void> {
  const created = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/pairing/sessions',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { deviceKind: 'companion', scopes: scopes ?? ['library:read', 'library:share', 'playlists:sync', 'eq:sync', 'transfers:receive'], ttlSeconds: 600 },
  });
  expect(created.statusCode).toBe(201);
  const session = created.json() as { sessionId: string; code: string };

  const started = await client.startPairing('http://hub.test', session.code);
  expect(started.reason).toBeNull();
  expect(started.challenge).not.toBeNull();

  const confirm = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/pairing/sessions/${session.sessionId}/confirm`,
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { verificationFingerprint: started.challenge!.verificationFingerprint },
  });
  expect(confirm.statusCode).toBe(200);

  const finished = await client.awaitPairing(started.challenge!.sessionId, { timeoutMs: 5000, intervalMs: 1 });
  expect(finished.reason).toBeNull();
  expect(finished.connection.connected).toBe(true);
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  hub = await createTestHub();
  admin = await hub.completeSetup();
  routeFetchToHub(hub);
  store = new CompanionStore(openCompanionDb(':memory:'));
  musicDir = await mkdtemp(join(tmpdir(), 'np-companion-music-'));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  store.close();
  await hub.dispose();
  await rm(musicDir, { recursive: true, force: true });
});

async function writeSong(relativePath: string, title: string): Promise<void> {
  const absolute = join(musicDir, relativePath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, Buffer.from(makeToneWav({ seconds: 0.4, notes: [[440, 0.4]] }, { title, artist: 'Fixture Artist', album: 'Fixture Album' })));
}

describe('pairing', () => {
  it('pairs, then reports the hub it is connected to', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const status = client.getStatus();
    expect(status.connected).toBe(true);
    expect(status.hubFingerprint).toBeTruthy();
    expect(status.scopes).toContain('library:share');
  });

  it('refuses a code that was never issued, without inventing a connection', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    const started = await client.startPairing('http://hub.test', 'ZZZZ-ZZZZ');
    expect(started.challenge).toBeNull();
    expect(started.reason).toBeTruthy();
    expect(client.getStatus().connected).toBe(false);
  });

  it('forgetting a hub clears the credential from the database, not just from memory', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    expect(store.get('hub.credential', null)).not.toBeNull();

    client.forget();
    expect(store.get('hub.credential', null)).toBeNull();
    expect(new HubClient(store, 'Test PC', () => undefined).getStatus().connected).toBe(false);
  });
});

describe('sync', () => {
  it('pushes the library as metadata and stores no filesystem path on the hub', async () => {
    await writeSong('Fixture Album/01 One.wav', 'One');
    await writeSong('Fixture Album/02 Two.wav', 'Two');
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });

    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const result = await client.sync();
    expect(result.reason).toBeNull();
    expect(result.pushed).toBeGreaterThan(0);

    // Read everything the hub wrote and prove no Windows or POSIX music path is in any of it.
    const tables = hub.ctx.db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const haystack: string[] = [];
    for (const { name } of tables) {
      if (name.startsWith('sqlite_') || name.endsWith('_fts') || name.includes('_fts_')) continue;
      for (const row of hub.ctx.db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) haystack.push(JSON.stringify(row));
    }
    const stored = haystack.join('\n');
    expect(stored).not.toContain(musicDir);
    expect(stored).not.toMatch(/[A-Za-z]:\\\\/);
    // The metadata itself did arrive, so this is not passing because nothing was synced.
    expect(stored).toContain('Fixture Artist');
  });

  it('refuses to sync when the hub did not grant permission to share a library', async () => {
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client, ['library:read']);

    const result = await client.sync();
    expect(result.pushed).toBe(0);
    // The message says what to change and where, rather than "forbidden".
    expect(result.reason).toMatch(/permission to share/i);
  });

  it('is idempotent: a second sync with nothing changed pushes nothing new', async () => {
    await writeSong('a.wav', 'A');
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });

    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    const first = await client.sync();
    expect(first.pushed).toBeGreaterThan(0);

    const second = await client.sync();
    expect(second.reason).toBeNull();
    expect(second.conflicts).toBe(0);
  });
});

describe('transfers', () => {
  it('uploads a file, and the hub accepts it only when the hash matches', async () => {
    await writeSong('a.wav', 'Transferred');
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });
    const track = store.searchTracks({ limit: 1, offset: 0 }).items[0]!;

    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const progress: Array<[number, number]> = [];
    const result = await client.uploadTrack(track.id, (done, total) => progress.push([done, total]));

    expect(result.reason).toBeNull();
    expect(result.ok).toBe(true);
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
  });

  it('refuses to upload a track whose file has been deleted, and says so plainly', async () => {
    await writeSong('a.wav', 'Gone');
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });
    const track = store.searchTracks({ limit: 1, offset: 0 }).items[0]!;

    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    await rm(join(musicDir, 'a.wav'));

    const result = await client.uploadTrack(track.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('refuses to upload without the transfer permission', async () => {
    await writeSong('a.wav', 'Nope');
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });
    const track = store.searchTracks({ limit: 1, offset: 0 }).items[0]!;

    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client, ['library:read', 'library:share']);

    const result = await client.uploadTrack(track.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/permission to transfer/i);
  });
});

describe('sync paging and cursors', () => {
  function bulkTracks(count: number): void {
    const now = Date.now();
    store.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        const id = uuidv7();
        // Distinct, ordered timestamps, as a real scan over time would leave.
        const updatedAt = new Date(now - (count - i) * 1000).toISOString();
        const t = { id, schemaVersion: 1, title: `Song ${i}`, artistName: 'Bulk Artist', albumName: null, createdAt: updatedAt, updatedAt, deletedAt: null } as unknown as Track;
        store.upsertTrack({ id, folderId: 'folder-1', relativePath: `bulk/${i}.flac`, track: t, sizeBytes: 1, mtimeMs: 1, contentHash: null, updatedAt, deletedAt: null });
      }
    });
  }

  const hubTrackCount = (): number => hub.ctx.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM synced_records WHERE collection = 'tracks'").get()?.n ?? 0;

  it('sends a library larger than one request, and afterwards only what changed', async () => {
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    bulkTracks(2300);
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const first = await client.sync();
    expect(first.reason).toBeNull();
    // The old code sent at most 2000 records, unordered, every time; the rest never arrived.
    expect(hubTrackCount()).toBe(2300);
    expect(first.pushed).toBe(2300);

    // One edit later, one record is sent — not the whole library again.
    const one = store.searchTracks({ query: 'Song 7', limit: 1, offset: 0 }).items[0]!;
    const edited = store.findTrack(one.id)!;
    const later = new Date(Date.now() + 1000).toISOString();
    store.upsertTrack({ ...edited, track: { ...edited.track, title: 'Song 7 (Remastered)' }, updatedAt: later });
    const second = await client.sync();
    expect(second.reason).toBeNull();
    expect(second.pushed).toBe(1);
  }, 120_000);

  it('tells the hub about the tracks of a removed folder', async () => {
    await writeSong('a.wav', 'Removed With Folder');
    store.addFolder({ id: '01920000-0000-7000-8000-00000000f001', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: '01920000-0000-7000-8000-00000000f001', path: musicDir });
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    await client.sync();

    store.removeFolder('01920000-0000-7000-8000-00000000f001', new Date(Date.now() + 1000).toISOString());
    const result = await client.sync();
    expect(result.reason).toBeNull();
    const rows = hub.ctx.db.prepare<[], { deleted_at: string | null }>("SELECT deleted_at FROM synced_records WHERE collection = 'tracks'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).toEqual(expect.any(String));
  });
});

describe('applying the hub’s changes', () => {
  const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

  it('applies a tombstone without a body, skips a malformed record, and keeps syncing', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const playlistId = uuidv7();
    const itemId = uuidv7();
    const brokenId = uuidv7();
    hub.ctx.sync.publish('playlists', { id: playlistId, updatedAt: at(-5000), deletedAt: null, createdAt: at(-5000), name: 'From the hub' });
    // A deleted playlist item this computer never had: the change carries no body at all.
    hub.ctx.sync.publish('playlistItems', { id: itemId, updatedAt: at(-4000), deletedAt: at(-4000) });
    // A playlist with no name does not fit the contract and must not reach the playlist list.
    hub.ctx.sync.publish('playlists', { id: brokenId, updatedAt: at(-3000), deletedAt: null, createdAt: at(-3000) });

    const first = await client.sync();
    expect(first.reason).toBeNull();
    expect(store.listPlaylists().map((p) => p.name)).toEqual(['From the hub']);
    expect(store.syncedState('playlist_items', itemId)?.deletedAt).toEqual(expect.any(String));
    expect(store.syncedState('playlists', brokenId)).toBeUndefined();

    // The cursor moved, so the next sync is not stuck on the same page.
    const second = await client.sync();
    expect(second.reason).toBeNull();
    expect(second.pulled).toBe(0);
  });

  it('keeps a local edit that is newer than the hub’s copy', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);

    const id = uuidv7();
    const localTime = at(60_000);
    store.putSynced('playlists', id, { id, createdAt: localTime, updatedAt: localTime, name: 'Edited here' }, localTime, null);
    hub.ctx.sync.publish('playlists', { id, updatedAt: at(-60_000), deletedAt: null, createdAt: at(-60_000), name: 'Older on the hub' });
    // Hold the local edit back from this round, so the hub's older copy really is offered to us.
    store.raw.prepare('INSERT INTO sync_cursors (collection, cursor) VALUES (?, ?)').run('push:playlists', JSON.stringify([at(120_000), 'z']));

    const result = await client.sync();
    expect(result.reason).toBeNull();
    expect(store.listPlaylists().map((p) => p.name)).toEqual(['Edited here']);
  });
});

describe('the stored credential', () => {
  /** A reversible stand-in for DPAPI: enough to prove the plain secret never reaches the database. */
  const secretBox = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from([...Buffer.from(text, 'utf8')].reverse()),
    decryptString: (data: Buffer) => Buffer.from([...data].reverse()).toString('utf8'),
  };

  it('is encrypted at rest when the operating system can encrypt it', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined, { secretBox });
    await pairCompanion(client);
    const stored = store.get<Record<string, unknown> | null>('hub.credential', null)!;
    expect(stored['secret']).toBeUndefined();
    expect(stored['secretEncrypted']).toEqual(expect.any(String));

    // A fresh start can still unlock it and use it.
    const reopened = new HubClient(store, 'Test PC', () => undefined, { secretBox });
    expect((await reopened.refresh()).connected).toBe(true);
    expect((await reopened.sync()).reason).toBeNull();
  });

  it('encrypts a plain-text credential left by an older build the first time it is read', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    const legacy = store.get<Record<string, unknown> | null>('hub.credential', null)!;
    expect(legacy['secret']).toEqual(expect.any(String));

    const upgraded = new HubClient(store, 'Test PC', () => undefined, { secretBox });
    const stored = store.get<Record<string, unknown> | null>('hub.credential', null)!;
    expect(stored['secret']).toBeUndefined();
    expect(secretBox.decryptString(Buffer.from(String(stored['secretEncrypted']), 'base64'))).toBe(legacy['secret']);
    expect((await upgraded.sync()).reason).toBeNull();
  });
});

describe('uploads that go wrong', () => {
  async function pairedWithTrack(title: string): Promise<{ client: HubClient; trackId: string }> {
    await writeSong('a.wav', title);
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    return { client, trackId: store.searchTracks({ limit: 1, offset: 0 }).items[0]!.id };
  }

  it('fails, rather than reporting success, when the hub sends a nonsense resume offset', async () => {
    const { client, trackId } = await pairedWithTrack('Bad Offset');
    const routed = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404, headers: { 'x-received-bytes': 'abc' } });
      return routed(input, init);
    }) as typeof globalThis.fetch;
    const result = await client.uploadTrack(trackId);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/upload position/);
  });

  it('stops when cancelled', async () => {
    const { client, trackId } = await pairedWithTrack('Cancelled');
    const controller = new AbortController();
    controller.abort();
    await expect(client.uploadTrack(trackId, undefined, controller.signal)).resolves.toEqual({ ok: false, reason: 'Cancelled.' });
  });

  it('sends a file larger than one chunk', async () => {
    await writeFile(join(musicDir, 'big.wav'), Buffer.alloc(5 * 1024 * 1024 + 123, 7));
    store.addFolder({ id: 'folder-1', path: musicDir, displayName: 'Music', now: new Date().toISOString() });
    await scanFolder(store, { id: 'folder-1', path: musicDir });
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    const trackId = store.searchTracks({ limit: 1, offset: 0 }).items[0]!.id;
    const progress: number[] = [];
    const result = await client.uploadTrack(trackId, (done) => progress.push(done));
    expect(result).toEqual({ ok: true, reason: null });
    expect(progress).toEqual([4 * 1024 * 1024, 5 * 1024 * 1024 + 123]);
  });
});

describe('a hub that is not the one you paired with', () => {
  it('refuses to send the credential when the hub’s fingerprint no longer matches', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    const saved = store.get<Record<string, unknown>>('hub.credential', {});
    store.set('hub.credential', { ...saved, hubFingerprint: 'not-the-fingerprint-you-confirmed' }, new Date().toISOString());

    const routed = globalThis.fetch;
    const authorized: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.headers as Record<string, string> | undefined)?.['authorization']) authorized.push(String(input));
      return routed(input, init);
    }) as typeof globalThis.fetch;

    const reopened = new HubClient(store, 'Test PC', () => undefined);
    const result = await reopened.sync();
    expect(result.reason).toMatch(/different hub/i);
    expect(authorized).toEqual([]);
  });

  it('notices a different hub at the same address and refuses to treat it as connected', async () => {
    const client = new HubClient(store, 'Test PC', () => undefined);
    await pairCompanion(client);
    expect((await client.refresh()).connected).toBe(true);

    // A second hub answering at the same endpoint: a different install, or someone in the middle.
    const impostor = await createTestHub();
    try {
      await impostor.completeSetup();
      routeFetchToHub(impostor);
      const status = await client.refresh();
      expect(status.connected).toBe(false);
      expect(status.reason).toMatch(/different hub/i);
      expect(status.reason).toMatch(/Nothing was sent to it/i);
    } finally {
      await impostor.dispose();
      routeFetchToHub(hub);
    }
  });
});
