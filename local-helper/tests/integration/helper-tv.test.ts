import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_ROUTES, HelperTvChannels, HelperTvGuide, type HelperTvChannel, type HelperTvGuideEntry } from '@now-playing/contracts';
import { startHelper, type Helper, type HelperOptions } from '../../src/server.js';

/**
 * Live TV through the helper. The companion keeps the playlists and the guides; the helper only
 * hands a vetted player page what the companion already holds. Nothing here touches the network:
 * the two lists are given to the helper by the test, exactly as the companion gives them.
 */
const TOKEN = 'tv-test-token-tv-test-token-tv-x';
const CHANNELS: HelperTvChannel[] = [
  { id: 'c0ffee0000000001', name: 'One', number: 1, group: 'News', logo: 'https://img.example.com/one.png', url: 'https://tv.example.com/one.m3u8', tvgId: 'one.example' },
  { id: 'c0ffee0000000002', name: 'Two', number: 2, group: null, logo: null, url: 'https://tv.example.com/two.m3u8', tvgId: null },
];
const GUIDE: HelperTvGuideEntry[] = [
  {
    tvgId: 'one.example',
    now: { title: 'Morning News', start: '2026-10-03T08:00:00.000Z', stop: '2026-10-03T09:00:00.000Z', description: 'The headlines.' },
    next: { title: 'Weather', start: '2026-10-03T09:00:00.000Z', stop: '2026-10-03T09:15:00.000Z', description: null },
  },
];

const roots: string[] = [];
const helpers: Helper[] = [];

async function start(tv?: HelperOptions['tv']): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'np-helper-tv-'));
  roots.push(root);
  const helper = await startHelper({
    port: 0,
    version: '1.0.0-test',
    token: TOKEN,
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 5_000,
    allowedHosts: [],
    allowedOrigins: [],
    loopbackPages: true,
    app: null,
    configured: {},
    log: () => {},
    ...(tv ? { tv } : {}),
  });
  helpers.push(helper);
  const address = helper.server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

let companion: string;
let standalone: string;
let asked = 0;

beforeAll(async () => {
  companion = await start({
    channels: () => {
      asked += 1;
      return CHANNELS;
    },
    guide: async () => GUIDE,
  });
  standalone = await start();
});

afterAll(async () => {
  for (const helper of helpers) await helper.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const page = { origin: 'http://127.0.0.1:4546' };

describe('Live TV through the helper', () => {
  it('gives a player page the channel list the companion keeps, in the contract’s shape, with no token', async () => {
    const response = await fetch(`${companion}${HELPER_ROUTES.tvChannels}`, { headers: page });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(page.origin);
    const body = HelperTvChannels.parse(await response.json());
    expect(body.channels).toEqual(CHANNELS);
  });

  it('gives now and next per tvg-id, stamped with when it was worked out', async () => {
    const before = Date.now();
    const response = await fetch(`${companion}${HELPER_ROUTES.tvGuide}`, { headers: page });
    expect(response.status).toBe(200);
    const body = HelperTvGuide.parse(await response.json());
    expect(body.guide).toEqual(GUIDE);
    expect(Date.parse(body.generatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('answers a helper with no companion behind it with empty lists, not an error', async () => {
    const channels = await fetch(`${standalone}${HELPER_ROUTES.tvChannels}`, { headers: page });
    expect(channels.status).toBe(200);
    expect(HelperTvChannels.parse(await channels.json())).toEqual({ channels: [] });
    const guide = await fetch(`${standalone}${HELPER_ROUTES.tvGuide}`, { headers: page });
    expect(guide.status).toBe(200);
    expect(HelperTvGuide.parse(await guide.json()).guide).toEqual([]);
  });

  it('refuses a site on the internet', async () => {
    for (const route of [HELPER_ROUTES.tvChannels, HELPER_ROUTES.tvGuide]) {
      const response = await fetch(`${companion}${route}`, { headers: { origin: 'https://evil.example' } });
      expect(response.status).toBe(403);
    }
  });

  it('refuses a request with no Origin (an <img> on any website) unless it carries the token', async () => {
    const before = asked;
    for (const route of [HELPER_ROUTES.tvChannels, HELPER_ROUTES.tvGuide]) {
      const blind = await fetch(`${companion}${route}`);
      expect(blind.status).toBe(403);
      const wrong = await fetch(`${companion}${route}`, { headers: { 'x-helper-token': 'not-the-token' } });
      expect(wrong.status).toBe(403);
      const tokened = await fetch(`${companion}${route}`, { headers: { 'x-helper-token': TOKEN } });
      expect(tokened.status).toBe(200);
    }
    // The refused requests never reached the list at all.
    expect(asked).toBe(before + 1);
  });

  it('is read-only: nothing but GET is served on these routes', async () => {
    const post = await fetch(`${companion}${HELPER_ROUTES.tvChannels}`, { method: 'POST', headers: { ...page, 'content-type': 'application/json' }, body: '{}' });
    // Falls through to the token-guarded API, which has no such route to POST to.
    expect([401, 404]).toContain(post.status);
  });
});
