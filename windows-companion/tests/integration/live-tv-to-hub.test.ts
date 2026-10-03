/**
 * The companion's Live TV, kept on the hub for players that are not on this PC.
 *
 * The real `HubClient` against the real hub application, with `fetch` routed into the hub's
 * injector (as in companion-and-hub.test.ts). Pinned: the copy is sent only while this PC shares
 * with the hub, a channel whose address carries a sign-in or is not a web link stays on this PC, and
 * turning sharing off removes the copy the hub was given.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HelperTvChannel, HelperTvGuideEntry } from '@now-playing/contracts';
import { createTestHub, type TestHub } from '../../../docker-container/tests/helpers/hub.js';
import { HubClient, type LiveTvSource } from '../../src/main/hub.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let store: CompanionStore;
let realFetch: typeof globalThis.fetch;

function routeFetchToHub(target: TestHub): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = init?.body;
    const response = await target.app.inject({ method: (init?.method ?? 'GET') as 'GET', url: url.pathname + url.search, headers, ...(typeof body === 'string' ? { payload: body } : {}) });
    const outHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') outHeaders.set(key, value);
    return new Response(response.statusCode === 204 ? null : response.rawPayload, { status: response.statusCode, headers: outHeaders });
  }) as typeof globalThis.fetch;
}

async function pairCompanion(client: HubClient, scopes = ['library:read', 'library:share']): Promise<void> {
  const created = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/sessions', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, payload: { deviceKind: 'companion', scopes, ttlSeconds: 600 } });
  const session = created.json() as { sessionId: string; code: string };
  const started = await client.startPairing('http://hub.test', session.code);
  await hub.app.inject({ method: 'POST', url: `/api/v1/pairing/sessions/${session.sessionId}/confirm`, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, payload: { verificationFingerprint: started.challenge!.verificationFingerprint } });
  const finished = await client.awaitPairing(started.challenge!.sessionId, { timeoutMs: 5000, intervalMs: 1 });
  expect(finished.connection.connected).toBe(true);
}

const channel = (n: number, url: string, logo: string | null = null): HelperTvChannel => ({ id: `c${n}`, name: `Channel ${n}`, number: n, group: null, logo, url, tvgId: `ch${n}` });
const programme = { title: 'News', start: '2026-01-01T00:00:00.000Z', stop: '2026-01-01T01:00:00.000Z', description: null };

function source(state: { sharing: boolean; channels: HelperTvChannel[]; guide: HelperTvGuideEntry[] }): LiveTvSource {
  return { channels: async () => state.channels, guide: async () => state.guide, sharing: () => state.sharing };
}

const summary = async () => (await hub.app.inject({ method: 'GET', url: '/api/v1/live-tv/summary', headers: { cookie: admin.cookie } })).json() as { channelCount: number; guideCount: number; sourceDevice: { name: string } | null };

beforeEach(async () => {
  realFetch = globalThis.fetch;
  hub = await createTestHub();
  admin = await hub.completeSetup();
  routeFetchToHub(hub);
  store = new CompanionStore(openCompanionDb(':memory:'));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  store.close();
  await hub.dispose();
});

describe('Live TV on the hub', () => {
  it('sends the channels and their guide while sharing is on, leaving out addresses with a sign-in', async () => {
    const client = new HubClient(store, 'Living room PC', () => undefined);
    await pairCompanion(client);
    const state = {
      sharing: true,
      channels: [channel(1, 'https://tv.example.com/1.m3u8', 'https://tv.example.com/1.png'), channel(2, 'http://user:secret@tv.example.com/2'), channel(3, 'https://tv.example.com/3', 'data:image/png;base64,AAAA')],
      guide: [
        { tvgId: 'ch1', now: programme, next: null },
        { tvgId: 'ch2', now: programme, next: null },
      ],
    };
    client.setLiveTvSource(source(state));
    expect(await client.pushLiveTv()).toEqual({ sent: true, reason: null });
    expect(await summary()).toMatchObject({ channelCount: 2, guideCount: 1, sourceDevice: { name: 'Living room PC' } });
    const kept = (await hub.app.inject({ method: 'GET', url: '/api/v1/live-tv', headers: { cookie: admin.cookie } })).json() as { channels: HelperTvChannel[] };
    expect(kept.channels.map((c) => c.url)).toEqual(['https://tv.example.com/1.m3u8', 'https://tv.example.com/3']);
    expect(kept.channels[1]!.logo).toBeNull();
    expect(JSON.stringify(kept)).not.toContain('secret');
  });

  it('sends nothing while sharing is off, and removes what was sent once it is turned off', async () => {
    const client = new HubClient(store, 'PC', () => undefined);
    await pairCompanion(client);
    const state = { sharing: false, channels: [channel(1, 'https://tv.example.com/1')], guide: [] };
    client.setLiveTvSource(source(state));
    expect(await client.pushLiveTv()).toEqual({ sent: false, reason: null });
    expect((await summary()).channelCount).toBe(0);
    state.sharing = true;
    await client.pushLiveTv();
    expect((await summary()).channelCount).toBe(1);
    state.sharing = false;
    expect(await client.pushLiveTv()).toEqual({ sent: true, reason: null });
    expect(await summary()).toMatchObject({ channelCount: 0, sourceDevice: null });
  });

  it('does nothing when the hub did not grant library:share', async () => {
    const client = new HubClient(store, 'PC', () => undefined);
    await pairCompanion(client, ['library:read']);
    client.setLiveTvSource(source({ sharing: true, channels: [channel(1, 'https://tv.example.com/1')], guide: [] }));
    expect(await client.pushLiveTv()).toEqual({ sent: false, reason: null });
    expect((await summary()).channelCount).toBe(0);
  });
});
