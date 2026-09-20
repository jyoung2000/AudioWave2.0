/**
 * Companion sync is isolated per owner: a device never pulls another user's records and cannot
 * overwrite or tombstone them; forbidden keys are refused at any depth.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeBody } from '../../src/sync/service.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

type Device = { deviceId: string; authorization: string };

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let alice: Device;
let mallory: Device;

const RECORD_ID = '44444444-4444-7444-8444-444444444444';

function change(overrides: Record<string, unknown>) {
  return { collection: 'playlists', id: RECORD_ID, updatedAt: '2026-01-02T00:00:00.000Z', deleted: false, body: { name: 'Alice private', trackIds: [] }, changeId: '55555555-5555-7555-8555-555555555555', ...overrides };
}

async function delta(device: Device, changes: unknown[], since: Record<string, string> = {}) {
  const response = await hub.app.inject({ method: 'POST', url: '/api/v1/sync/delta', headers: { authorization: device.authorization }, payload: { deviceId: device.deviceId, since, changes, enabledCollections: ['playlists'] } });
  expect(response.statusCode).toBe(200);
  return response.json() as { applied: number; duplicates: number; changes: Array<{ id: string; body?: Record<string, unknown> | null }> };
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  alice = await pairDevice(hub, admin, { name: 'Alice phone' });
  mallory = await pairDevice(hub, admin, { name: 'Mallory phone' });
  expect((await delta(alice, [change({})])).applied).toBe(1);
});

afterEach(async () => {
  await hub.dispose();
});

describe('sync isolation', () => {
  it("never returns another user's records in a pull", async () => {
    const pulled = await delta(mallory, []);
    expect(pulled.changes.map((c) => c.id)).not.toContain(RECORD_ID);
    expect(JSON.stringify(pulled)).not.toContain('Alice private');
    const status = await hub.app.inject({ method: 'GET', url: '/api/v1/sync/status', headers: { authorization: mallory.authorization } });
    expect(status.json()).toMatchObject({ pendingRemote: 0 });
  });

  it("refuses to overwrite another user's record", async () => {
    const result = await delta(mallory, [change({ updatedAt: '2026-02-01T00:00:00.000Z', body: { name: 'pwned', trackIds: [] }, changeId: '66666666-6666-7666-8666-666666666666' })]);
    expect(result.applied).toBe(0);
    const stored = hub.ctx.repos.sync.get('playlists', RECORD_ID);
    expect(stored?.['name']).toBe('Alice private');
    expect(stored?.originDeviceId).toBe(alice.deviceId);
    expect(stored?.ownerId).toMatch(/^user:/);
  });

  it("refuses to tombstone another user's record", async () => {
    const result = await delta(mallory, [change({ updatedAt: '2026-02-01T00:00:00.000Z', deleted: true, body: null, changeId: '77777777-7777-7777-8777-777777777777' })]);
    expect(result.applied).toBe(0);
    expect(hub.ctx.repos.sync.get('playlists', RECORD_ID)?.deletedAt).toBeNull();
  });

  it('still lets the owner update its own record', async () => {
    const result = await delta(alice, [change({ updatedAt: '2026-02-01T00:00:00.000Z', body: { name: 'Renamed', trackIds: [] }, changeId: '88888888-8888-7888-8888-888888888888' })]);
    expect(result.applied).toBe(1);
    expect(hub.ctx.repos.sync.get('playlists', RECORD_ID)?.['name']).toBe('Renamed');
  });

  it('shares hub-published records with every device, read-only', async () => {
    hub.ctx.sync.publish('playlists', { id: '99999999-9999-7999-8999-999999999999', updatedAt: '2026-01-03T00:00:00.000Z', deletedAt: null, name: 'Hub mix' } as never);
    const pulled = await delta(mallory, []);
    expect(pulled.changes.map((c) => c.id)).toContain('99999999-9999-7999-8999-999999999999');
    const write = await delta(mallory, [change({ id: '99999999-9999-7999-8999-999999999999', updatedAt: '2026-02-01T00:00:00.000Z', body: { name: 'hijacked' }, changeId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa' })]);
    expect(write.applied).toBe(0);
  });

  it('rejects forbidden keys nested anywhere in a body', async () => {
    expect(sanitizeBody({ body: { name: 'x' } })).toBe(true);
    expect(sanitizeBody({ body: { meta: { source: { absolutePath: 'C:/x' } } } })).toBe(false);
    expect(sanitizeBody({ body: { items: [{ ok: 1 }, { AccessToken: 'x' }] } })).toBe(false);
    const result = await delta(alice, [change({ id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', body: { name: 'Leaky', extra: { nested: [{ filePath: '/home/alex/song.flac' }] } }, changeId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc' })]);
    expect(result.applied).toBe(0);
    expect(hub.ctx.repos.sync.get('playlists', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb')).toBeUndefined();
  });
});
