/**
 * The two hub halves of "hear a song on the radio, keep it":
 * - GET /radio/now-playing reads a station's ICY title (the reader is injected; the real one is
 *   covered against live sockets in packages/domain/tests/integration/radio-node.test.ts);
 * - POST /groups/:id/requests queues a song by its name, the way Discord's /play does.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { StationNowPlaying } from '@now-playing/contracts';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio', import.meta.url));

let hub: TestHub | null = null;
afterEach(async () => {
  await hub?.dispose();
  hub = null;
});

describe('GET /radio/now-playing', () => {
  it("answers with the station's title, and shares one read between devices", async () => {
    const asked: string[] = [];
    hub = await createTestHub({
      deps: {
        stationTitle: async (url: string): Promise<StationNowPlaying> => {
          asked.push(url);
          return { raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: 'Test FM', reason: null };
        },
      },
    });
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.example.com/live')}`;
    const first = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ artist: 'Artist', title: 'Song', station: 'Test FM', reason: null });
    await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(asked).toEqual(['https://stream.example.com/live']);
  });

  it('needs a paired device', async () => {
    hub = await createTestHub();
    await hub.completeSetup();
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/radio/now-playing?url=https%3A%2F%2Fx.example%2Fs' });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a private address with a reason instead of connecting', async () => {
    hub = await createTestHub();
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/radio/now-playing?url=${encodeURIComponent('http://192.168.1.1:8000/stream')}`, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: null, reason: 'Private or local addresses are blocked' });
  });
});

describe('POST /groups/:id/requests', () => {
  async function groupWithFixtures() {
    hub = await createTestHub({ config: { publicDomainDir: FIXTURES } });
    const admin = await hub.completeSetup();
    await hub.ctx.library.scanAll();
    const device = await pairDevice(hub, admin);
    const created = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name: 'Radio room' } });
    expect(created.statusCode).toBe(201);
    return { admin, device, groupId: (created.json() as { id: string }).id };
  }

  it('finds a playable copy of the named song and appends it', async () => {
    const { device, groupId } = await groupWithFixtures();
    const response = await hub!.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/requests`, headers: { authorization: device.authorization }, payload: { query: 'Fennel Grove - Paper Harbour' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: true, title: 'Paper Harbour', artistName: 'Fennel Grove', reason: null });
    const queue = await hub!.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: device.authorization } });
    expect((queue.json() as { queue: { items: Array<{ track: { title: string } }> } }).queue.items.map((i) => i.track.title)).toContain('Paper Harbour');
  });

  it('never queues a same-titled song by someone else', async () => {
    const { device, groupId } = await groupWithFixtures();
    const response = await hub!.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/requests`, headers: { authorization: device.authorization }, payload: { query: 'Someone Else - Paper Harbour' } });
    const body = response.json() as { queued: boolean; reason: string | null };
    expect(body.queued).toBe(false);
    expect(body.reason).toMatch(/Someone Else/);
  });

  it('says why when nothing that plays here matches, and queues nothing', async () => {
    const { device, groupId } = await groupWithFixtures();
    const response = await hub!.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/requests`, headers: { authorization: device.authorization }, payload: { query: 'Nobody - No Such Song Zzqx' } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { queued: boolean; reason: string | null };
    expect(body.queued).toBe(false);
    expect(body.reason).toBeTruthy();
    const queue = await hub!.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: device.authorization } });
    expect((queue.json() as { queue: { items: unknown[] } }).queue.items).toHaveLength(0);
  });

  it('refuses a device that is not in the group', async () => {
    const { admin, groupId } = await groupWithFixtures();
    const stranger = await pairDevice(hub!, admin, { name: 'Stranger' });
    const response = await hub!.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/requests`, headers: { authorization: stranger.authorization }, payload: { query: 'Paper Harbour' } });
    expect(response.statusCode).toBe(403);
  });
});
