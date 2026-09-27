import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_ROUTES, type StationNowPlaying } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';

/**
 * The helper the way the companion runs it: API only, answering player pages on this machine's
 * loopback address, with the radio-title route open to them without a token.
 */
let helper: Helper;
let root: string;
let base: string;
const asked: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-radio-'));
  helper = await startHelper({
    port: 0,
    version: '1.0.0-test',
    token: 'radio-test-token-radio-test-token',
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 5_000,
    allowedHosts: [],
    allowedOrigins: [],
    loopbackPages: true,
    app: null,
    configured: {},
    log: () => {},
    stationTitle: async (url: string): Promise<StationNowPlaying> => {
      asked.push(url);
      return { raw: 'Artist - Song', artist: 'Artist', title: 'Song', station: 'Test FM', reason: null };
    },
  });
  const address = helper.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await helper.close();
  rmSync(root, { recursive: true, force: true });
});

const station = encodeURIComponent('https://stream.example.com/live');

describe('the companion helper and a player page', () => {
  it('a player opened from the hub reaches health (it used to get 403)', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.health}`, { headers: { origin: 'http://127.0.0.1:4546' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4546');
  });

  it("reads a station's title for a loopback page, with no token, and shares one read", async () => {
    const first = await fetch(`${base}${HELPER_ROUTES.radioNowPlaying}?url=${station}`, { headers: { origin: 'http://127.0.0.1:4174' } });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ artist: 'Artist', title: 'Song', reason: null });
    await fetch(`${base}${HELPER_ROUTES.radioNowPlaying}?url=${station}`, { headers: { origin: 'http://localhost:4174' } });
    expect(asked).toEqual(['https://stream.example.com/live']);
  });

  it('a site on the internet is still refused, and every other route still needs the token', async () => {
    const remote = await fetch(`${base}${HELPER_ROUTES.radioNowPlaying}?url=${station}`, { headers: { origin: 'https://evil.example' } });
    expect(remote.status).toBe(403);
    const job = await fetch(`${base}${HELPER_ROUTES.job('x')}`, { headers: { origin: 'http://127.0.0.1:4174' } });
    expect(job.status).toBe(401);
  });

  it('asks which station when none is named', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.radioNowPlaying}`, { headers: { origin: 'http://127.0.0.1:4174' } });
    expect(response.status).toBe(400);
  });
});
