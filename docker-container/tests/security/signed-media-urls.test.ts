/**
 * `<audio>` cannot send a bearer credential, so devices stream through signed URLs. A signature
 * must open exactly one path, for a limited time, for a device that is still paired.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio', import.meta.url));
const META = { ip: null, userAgent: null, correlationId: null };

let hub: TestHub;
let device: { deviceId: string; authorization: string };
let trackIds: string[];

beforeEach(async () => {
  hub = await createTestHub({ config: { publicDomainDir: FIXTURES } });
  const admin = await hub.completeSetup();
  await hub.ctx.library.scanAll();
  device = await pairDevice(hub, admin);
  trackIds = hub.ctx.library
    .listTracks({ limit: 5 })
    .items.map((t) => t.id)
    .slice(0, 2);
});

afterEach(async () => {
  await hub.dispose();
});

async function signedUrl(trackId: string): Promise<string> {
  const response = await hub.app.inject({ method: 'POST', url: '/api/v1/library/stream-urls', headers: { authorization: device.authorization }, payload: { trackIds: [trackId] } });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { items: Array<{ trackId: string; url: string }>; expiresAt: string };
  const url = new URL(body.items[0]!.url);
  expect(url.searchParams.get('sig')).not.toContain(device.authorization.split('.').pop());
  return `${url.pathname}${url.search}`;
}

describe('signed media URLs', () => {
  it('stream without a credential, including range requests', async () => {
    expect(trackIds.length).toBe(2);
    const path = await signedUrl(trackIds[0]!);
    const full = await hub.app.inject({ method: 'GET', url: path });
    expect(full.statusCode).toBe(200);
    const partial = await hub.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-99' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toMatch(/^bytes 0-99\//);
  });

  it('refuses a missing, altered or borrowed signature', async () => {
    const path = await signedUrl(trackIds[0]!);
    expect((await hub.app.inject({ method: 'GET', url: path.split('?')[0]! })).statusCode).toBe(401);
    expect((await hub.app.inject({ method: 'GET', url: `${path.slice(0, -2)}xx` })).statusCode).toBe(401);
    const other = `/api/v1/library/stream/${trackIds[1]!}?${path.split('?')[1]!}`;
    expect((await hub.app.inject({ method: 'GET', url: other })).statusCode).toBe(401);
  });

  it('expires, and dies with the device', async () => {
    const path = await signedUrl(trackIds[0]!);
    hub.clock.advance(7 * 3600 * 1000);
    expect((await hub.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);

    const fresh = await signedUrl(trackIds[0]!);
    hub.ctx.devices.revoke(device.deviceId, META, { id: 'admin', displayName: 'Admin' });
    expect((await hub.app.inject({ method: 'GET', url: fresh })).statusCode).toBe(401);
  });

  it('are issued only to devices', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/library/stream-urls', payload: { trackIds: [trackIds[0]!] } });
    expect(response.statusCode).toBe(401);
  });
});
