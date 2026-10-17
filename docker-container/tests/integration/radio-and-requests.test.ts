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

  it('returns the active BBC programme from the official schedule even when the stream has no song title', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: null, artist: null, title: null, station: null, reason: 'The station does not send song titles' }) } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_6music', () => ({ body: {
      service: { id: 'bbc_6music', name: 'BBC Radio 6 Music' },
      items: [
        { service: { id: 'bbc_6music' }, brand: { title: 'Yesterday Show' }, published_time: { start: '2025-01-01T09:00:00Z', end: '2025-01-01T10:00:00Z' } },
        { service: { id: 'bbc_6music' }, brand: { title: 'The Craig Charles Funk and Soul Show' }, episode: { title: 'Funk selection' }, published_time: { start: '2025-01-01T10:00:00Z', end: '2025-01-01T12:00:00Z' } },
      ],
    } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    hub.clock.set(new Date('2025-01-01T11:00:00Z').getTime());
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: null, programme: 'The Craig Charles Funk and Soul Show', programmeSource: 'schedule' });
    expect(hub.fetch.calls.map((call) => call.url)).toEqual(['https://ess.api.bbci.co.uk/schedules?serviceId=bbc_6music']);
  });

  it('looks up BBC Radio 4 FM using its actual schedule service ID', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: null, artist: null, title: null, station: null, reason: 'No song metadata' }) } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_radio_fourfm', () => ({ body: {
      service: { id: 'bbc_radio_fourfm' }, items: [{ service: { id: 'bbc_radio_fourfm' }, brand: { title: 'Today' },
        published_time: { start: '2026-10-17T09:00:00Z', end: '2026-10-17T10:00:00Z' } }],
    } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    hub.clock.set(new Date('2026-10-17T09:30:00Z').getTime());
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_radio_fourfm')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ programme: 'Today', programmeSource: 'schedule' });
    expect(hub.fetch.calls.map((call) => call.url)).toEqual(['https://ess.api.bbci.co.uk/schedules?serviceId=bbc_radio_fourfm']);
  });

  it('keeps the ICY song separate from the scheduled programme, and shares both in the cache', async () => {
    let reads = 0;
    hub = await createTestHub({ deps: { stationTitle: async () => {
      reads += 1;
      return { raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: 'BBC Radio 6 Music', reason: null };
    } } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_6music', () => ({ body: {
      service: { id: 'bbc_6music' }, items: [{ service: { id: 'bbc_6music' }, brand: { title: 'The Morning Show' },
        published_time: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' } }],
    } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    for (let n = 0; n < 2; n += 1) {
      const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ title: 'Song', artist: 'Artist', programme: 'The Morning Show', programmeSource: 'schedule' });
    }
    expect(reads).toBe(1);
    expect(hub.fetch.calls).toHaveLength(1);
  });

  it('does not request a schedule for a host spoofing the BBC stream name', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: null, reason: null }) } });
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk.evil.test/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: 'Song', programme: null, programmeSource: null });
    expect(hub.fetch.calls).toHaveLength(0);
  });

  it('ignores a redirect from the schedule API instead of following it to a private host', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: null, reason: null }) } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_6music', () => ({ status: 302, body: '', headers: { location: 'http://127.0.0.1/admin' } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: 'Song', programme: null, programmeSource: null });
    expect(hub.fetch.calls.map((call) => call.url)).toEqual(['https://ess.api.bbci.co.uk/schedules?serviceId=bbc_6music']);
  });

  it('does not call the schedule API when its hostname resolves to a private address', async () => {
    hub = await createTestHub({ deps: {
      dnsLookup: async () => ['127.0.0.1'],
      stationTitle: async () => ({ raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: null, reason: null }),
    } });
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: 'Song', programme: null, programmeSource: null });
    expect(hub.fetch.calls).toHaveLength(0);
  });

  it('uses the official episode title when the schedule has no programme brand', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: null, artist: null, title: null, station: null, reason: 'No song title' }) } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_6music', () => ({ body: {
      service: { id: 'bbc_6music' }, items: [{ service: { id: 'bbc_6music' }, brand: { title: '  ' },
        episode: { title: 'Saturday Night Sessions' }, published_time: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' } }],
    } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: null, programme: 'Saturday Night Sessions', programmeSource: 'schedule' });
  });

  it('does not label a stale or mismatched schedule entry as the current programme', async () => {
    hub = await createTestHub({ deps: { stationTitle: async () => ({ raw: null, artist: null, title: null, station: null, reason: 'No song title' }) } });
    hub.fetch.on('ess.api.bbci.co.uk/schedules?serviceId=bbc_6music', () => ({ body: {
      service: { id: 'bbc_6music' }, items: [
        { service: { id: 'bbc_6music' }, brand: { title: 'Earlier' }, published_time: { start: '2025-12-31T22:00:00Z', end: '2025-12-31T23:00:00Z' } },
        { service: { id: 'bbc_radio_one' }, brand: { title: 'Other station' }, published_time: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' } },
      ],
    } }));
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const url = `/api/v1/radio/now-playing?url=${encodeURIComponent('https://stream.live.vc.bbcmedia.co.uk/bbc_6music')}`;
    const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: device.authorization } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ title: null, programme: null, programmeSource: null });
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
