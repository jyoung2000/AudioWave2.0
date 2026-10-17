import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_ROUTES, type HelperTvChannel, type HelperTvGuideEntry, type StationNowPlaying } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';

const stream = 'https://radio.example/live';
const channel: HelperTvChannel = { id: 'radio-1', name: 'Community FM', number: 1, group: null, logo: null, url: stream, tvgId: 'fm-1' };
let helper: Helper;
let root: string;
let base: string;
let channels: HelperTvChannel[] = [channel];
const start = new Date(Date.now() - 60_000).toISOString();
const stop = new Date(Date.now() + 60_000).toISOString();
let guide: HelperTvGuideEntry[] = [{ tvgId: 'fm-1', now: { title: 'Morning News', start, stop, description: null }, next: null }];
let track: StationNowPlaying = { raw: 'Band - Song', artist: 'Band', title: 'Song', station: null, reason: null };
let reads = 0;
let guideFails = false;

afterEach(() => {
  guideFails = false;
  channels = [channel];
  guide = [{ tvgId: 'fm-1', now: { title: 'Morning News', start, stop, description: null }, next: null }];
  track = { raw: 'Band - Song', artist: 'Band', title: 'Song', station: null, reason: null };
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-radio-programme-'));
  helper = await startHelper({
    port: 0, version: 'test', token: 'radio-programme-test-token', workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'), timeoutMs: 5000, allowedHosts: [], allowedOrigins: [],
    loopbackPages: true, app: null, configured: {}, log: () => {},
    tv: { channels: () => channels, guide: () => { if (guideFails) throw new Error('guide unavailable'); return guide; } },
    stationTitle: async () => { reads += 1; return track; },
  });
  base = helper.origin;
});

afterAll(async () => {
  await helper?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function ask(url = stream): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${HELPER_ROUTES.radioNowPlaying}?url=${encodeURIComponent(url)}`, {
    headers: { origin: 'http://127.0.0.1:4174' },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

describe('Companion radio metadata through the helper', () => {
  it('returns the currently scheduled programme separately from the ICY track and resolves station from the matching playlist', async () => {
    expect(await ask()).toMatchObject({
      raw: 'Band - Song', artist: 'Band', title: 'Song', station: 'Community FM', reason: null,
      programme: 'Morning News', programmeSource: 'schedule',
    });
    expect(reads).toBe(1);
  });

  it('keeps the known station and ICY song when the XMLTV cache cannot be read', async () => {
    guideFails = true;
    expect(await ask()).toMatchObject({
      raw: 'Band - Song', title: 'Song', station: 'Community FM', programme: null, programmeSource: null,
    });
    expect(reads).toBe(1); // The ICY read is shared, but guide lookup is live.
  });

  it('rechecks the guide on a cached stream when a programme ends or the next one starts', async () => {
    guide = [{ tvgId: 'fm-1', now: null, next: { title: 'Later', start: new Date(Date.now() + 60_000).toISOString(), stop: new Date(Date.now() + 120_000).toISOString(), description: null } }];
    expect(await ask()).toMatchObject({ programme: null, programmeSource: null, station: 'Community FM' });
    guide = [{ tvgId: 'fm-1', now: { title: 'Live Talk', start: new Date(Date.now() - 1000).toISOString(), stop: new Date(Date.now() + 60_000).toISOString(), description: null }, next: null }];
    expect(await ask()).toMatchObject({ programme: 'Live Talk', programmeSource: 'schedule', title: 'Song' });
    expect(reads).toBe(1);
  });

  it('does not invent a programme from an ICY title or a guide for another station', async () => {
    channels = [];
    expect(await ask()).toMatchObject({ title: 'Song', programme: null, programmeSource: null, station: null });
    channels = [channel];
    guide = [{ tvgId: 'another-station', now: { title: 'Wrong Station', start, stop, description: null }, next: null }];
    expect(await ask()).toMatchObject({ title: 'Song', station: 'Community FM', programme: null, programmeSource: null });
  });

  it('retains the ICY station name and does not guess a programme when the guide is out of date', async () => {
    track = { raw: null, artist: null, title: null, station: 'Live Stream Name', reason: 'No song metadata.' };
    guide = [{ tvgId: 'fm-1', now: { title: 'Old Show', start: '2020-01-01T10:00:00.000Z', stop: '2020-01-01T11:00:00.000Z', description: null }, next: null }];
    // A fresh stream URL bypasses the cached first-test title but uses the same playlist channel.
    channels = [{ ...channel, url: `${stream}?live=1` }];
    expect(await ask(`${stream}?live=1`)).toMatchObject({ station: 'Live Stream Name', title: null, programme: null, programmeSource: null, reason: 'No song metadata.' });
  });
});
