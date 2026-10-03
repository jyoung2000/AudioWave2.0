/**
 * Live TV, end to end on this machine: a link is pasted, read by the real reader from a server on
 * 127.0.0.1, kept only when it holds what it claims, cached beside the database, and handed to a
 * player page through the helper's two routes.
 *
 * Nothing here reaches the internet. The fixture server is local, which is exactly what the reader
 * refuses in the app — so the tests that prove the refusal run without the test-only switch, and
 * everything else runs with it.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HELPER_ROUTES, HelperTvChannels, HelperTvGuide } from '@now-playing/contracts';
import { startHelper, type Helper } from '@now-playing/local-helper';
import { LiveTv, REFRESH_MS } from '../../src/main/live-tv/index.js';
import { LinkError, checkLink, readLink, type ReadLinkOptions } from '../../src/main/live-tv/fetch.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import type { TvLinks } from '../../src/shared/ipc.js';

const NOW = Date.parse('2026-10-03T08:30:00.000Z');
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
const HOUR = 60 * 60 * 1000;

const PLAYLIST = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="One.Example" tvg-logo="https://img.example.com/one.png" tvg-chno="7" group-title="News",One',
  'https://tv.example.com/one.m3u8',
  '#EXTINF:-1 tvg-id="two.example",Two',
  'https://tv.example.com/two.m3u8',
  '#EXTINF:-1,Three',
  'https://tv.example.com/three.m3u8',
].join('\n');

const SECOND_PLAYLIST = ['#EXTM3U', '#EXTINF:-1 tvg-chno="7",Seven Again', 'https://tv.example.com/seven.m3u8', '#EXTINF:-1,One, repeated', 'https://tv.example.com/one.m3u8'].join('\n');

function guide(days = 7): string {
  const rows: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>', '<channel id="one.example"><display-name>One</display-name></channel>', '<channel id="two.example"><display-name>Two</display-name></channel>'];
  // One an hour on channel one, from a day ago to `days` days on; channel two has a gap right now.
  for (let t = NOW - 24 * HOUR - 30 * 60_000; t < NOW + (days - 1) * 24 * HOUR; t += HOUR) rows.push(`<programme start="${stamp(t)}" stop="${stamp(t + HOUR)}" channel="one.example"><title>Hour ${new Date(t).toISOString().slice(11, 16)}</title><desc>About it &amp; more.</desc></programme>`);
  rows.push(`<programme start="${stamp(NOW + 30 * 60_000)}" stop="${stamp(NOW + 90 * 60_000)}" channel="two.example"><title>Later On Two</title></programme>`);
  const farOff = NOW + (days - 1) * 24 * HOUR - 2 * HOUR;
  rows.push(`<programme start="${stamp(farOff)}" stop="${stamp(farOff + HOUR)}" channel="unlisted.example"><title>Far Off</title></programme>`);
  rows.push('</tv>');
  return rows.join('\n');
}

let server: Server;
let base: string;
let requests: string[] = [];
const routes = new Map<string, { status?: number; body?: Buffer | string; headers?: Record<string, string>; hang?: boolean }>();

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const route = routes.get(request.url ?? '');
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/html' });
      return void response.end('<html><body>Not found</body></html>');
    }
    if (route.hang) return;
    response.writeHead(route.status ?? 200, route.headers ?? {});
    response.end(route.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let root: string;
let store: CompanionStore;
let clock: { now: number };
let changes: TvLinks[];
const made: LiveTv[] = [];

function liveTv(overrides: Partial<ConstructorParameters<typeof LiveTv>[0]> = {}): LiveTv {
  const tv = new LiveTv({ store, cacheDir: join(root, 'live-tv'), version: '0.1.0-test', log: () => undefined, onChange: (links) => changes.push(links), now: () => clock.now, allowPrivateNetworkForTests: true, ...overrides });
  made.push(tv);
  return tv;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-companion-tv-'));
  store = new CompanionStore(openCompanionDb(':memory:'));
  clock = { now: NOW };
  changes = [];
  requests = [];
  routes.clear();
  routes.set('/channels.m3u8', { body: PLAYLIST, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  routes.set('/second.m3u', { body: SECOND_PLAYLIST });
  routes.set('/guide.xml', { body: guide(), headers: { 'content-type': 'text/xml' } });
  routes.set('/guide.xml.gz', { body: gzipSync(guide(3)) });
});

afterEach(() => {
  for (const tv of made.splice(0)) tv.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('adding a channel playlist', () => {
  it('reads the link, keeps it with how many channels it holds, and remembers it', async () => {
    const tv = liveTv();
    const added = await tv.add('m3u', `${base}/channels.m3u8`);
    expect(added.reason).toBeNull();
    expect(added.link).toMatchObject({ kind: 'm3u', url: `${base}/channels.m3u8`, state: 'ok', summary: '3 channels', error: null });
    expect(tv.list().m3u).toHaveLength(1);
    // The window is told, so the row appears without it asking.
    expect(changes.at(-1)?.m3u[0]?.summary).toBe('3 channels');
    // A second companion over the same database and cache has the link and its channels at once,
    // with nothing fetched again.
    const before = requests.length;
    const again = liveTv();
    expect(again.list().m3u[0]).toMatchObject({ url: `${base}/channels.m3u8`, state: 'ok', summary: '3 channels' });
    expect(await again.channels()).toHaveLength(3);
    expect(requests.length).toBe(before);
  });

  it('refuses what is not a playlist, in a sentence, and keeps nothing', async () => {
    const tv = liveTv();
    routes.set('/page.m3u', { body: '<html><body>Welcome</body></html>' });
    expect(await tv.add('m3u', `${base}/page.m3u`)).toEqual({ link: null, reason: 'That doesn’t look like an M3U playlist — no channels were found in it.' });
    expect(await tv.add('m3u', `${base}/missing.m3u`)).toEqual({ link: null, reason: 'That link answered, but there is no playlist there. Check the address and try again.' });
    expect(await tv.add('m3u', 'channels.m3u8')).toEqual({ link: null, reason: 'That doesn’t look like a link — it should start with https:// or http://.' });
    expect(await tv.add('m3u', 'ftp://tv.example.com/channels.m3u')).toMatchObject({ link: null, reason: expect.stringContaining('https://') });
    expect(tv.list().m3u).toEqual([]);
    expect(existsSync(join(root, 'live-tv')) ? readdirSync(join(root, 'live-tv')) : []).toEqual([]);
    expect(store.get<unknown>('liveTv', null)).toBeNull();
  });

  it('will not keep the same link twice', async () => {
    const tv = liveTv();
    await tv.add('m3u', `${base}/channels.m3u8`);
    expect(await tv.add('m3u', `${base}/channels.m3u8`)).toEqual({ link: null, reason: 'That link is already in the list.' });
    expect(tv.list().m3u).toHaveLength(1);
  });

  it('follows a redirect, and treats a link that is itself a stream as one channel', async () => {
    const tv = liveTv();
    routes.set('/moved', { status: 302, headers: { location: '/channels.m3u8' } });
    expect((await tv.add('m3u', `${base}/moved`)).link?.summary).toBe('3 channels');
    routes.set('/live/news.m3u8', { body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg-1.ts\n' });
    expect((await tv.add('m3u', `${base}/live/news.m3u8`)).link?.summary).toBe('1 channel');
    expect((await tv.channels()).at(-1)).toMatchObject({ name: 'news', url: `${base}/live/news.m3u8` });
  });

  it('removes a link, its channels and its cache file', async () => {
    const tv = liveTv();
    const { link } = await tv.add('m3u', `${base}/channels.m3u8`);
    expect(readdirSync(join(root, 'live-tv'))).toHaveLength(1);
    expect(tv.remove(link!.id)).toEqual({ ok: true });
    expect(tv.list().m3u).toEqual([]);
    expect(await tv.channels()).toEqual([]);
    await expect.poll(() => readdirSync(join(root, 'live-tv'))).toEqual([]);
    expect(tv.remove(link!.id)).toEqual({ ok: false });
  });
});

describe('only public addresses are read', () => {
  it('refuses this PC and the home network before anything is connected', async () => {
    const tv = liveTv({ allowPrivateNetworkForTests: false });
    const sentence = 'That address is on this PC or your own network. Live TV links need an address on the internet.';
    for (const url of [`${base}/channels.m3u8`, 'http://localhost/channels.m3u8', 'http://192.168.1.20/channels.m3u', 'http://10.0.0.5:8080/guide.xml', 'http://[::1]/x.m3u']) {
      expect(await tv.add('m3u', url)).toEqual({ link: null, reason: sentence });
    }
    expect(requests).toEqual([]);
    expect(checkLink('https://user:secret@tv.example.com/x.m3u')?.kind).toBe('invalid');
    expect(checkLink('https://tv.example.com/x.m3u')).toBeNull();
  });

  it('is refused by the reader itself, not only by the form in front of it', async () => {
    const options: ReadLinkOptions = { timeoutMs: 5_000, maxBytes: 1_000_000, maxDecodedBytes: 1_000_000, userAgent: 'test' };
    await expect(readLink('http://169.254.169.254/latest/meta-data', options, () => undefined)).rejects.toMatchObject({ kind: 'private' });
    await expect(readLink(`${base}/channels.m3u8`, options, () => undefined)).rejects.toBeInstanceOf(LinkError);
  });
});

describe('the reader has limits', () => {
  const options = (extra: Partial<ReadLinkOptions> = {}): ReadLinkOptions => ({ timeoutMs: 5_000, maxBytes: 1_000_000, maxDecodedBytes: 1_000_000, userAgent: 'test', allowPrivateNetworkForTests: true, ...extra });

  it('stops at the size cap, on the wire and after unpacking', async () => {
    routes.set('/big.m3u', { body: Buffer.alloc(200_000, 0x41) });
    await expect(readLink(`${base}/big.m3u`, options({ maxBytes: 50_000 }), () => undefined)).rejects.toMatchObject({ kind: 'too-large' });
    // 5 MB of one letter is a few kilobytes gzipped: small on the wire, not small.
    routes.set('/bomb.xml.gz', { body: gzipSync(Buffer.alloc(5_000_000, 0x41)) });
    await expect(readLink(`${base}/bomb.xml.gz`, options({ maxDecodedBytes: 100_000 }), () => undefined)).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('gives up on a link that never answers, and on one that redirects for ever', async () => {
    routes.set('/hang', { hang: true });
    await expect(readLink(`${base}/hang`, options({ timeoutMs: 300 }), () => undefined)).rejects.toMatchObject({ kind: 'timeout' });
    routes.set('/loop', { status: 302, headers: { location: '/loop' } });
    await expect(readLink(`${base}/loop`, options(), () => undefined)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(requests.filter((r) => r === '/loop')).toHaveLength(6);
  });

  it('hands the body over in pieces, unpacking gzip by what it is rather than what it is called', async () => {
    routes.set('/guide-without-the-ending', { body: gzipSync(guide(3)) });
    let text = '';
    let pieces = 0;
    const result = await readLink(`${base}/guide-without-the-ending`, options({ maxBytes: 10_000_000, maxDecodedBytes: 10_000_000 }), (piece) => {
      text += piece;
      pieces += 1;
    });
    expect(result.gzip).toBe(true);
    expect(text).toBe(guide(3));
    expect(pieces).toBeGreaterThan(0);
    expect(result.bytes).toBeLessThan(result.decodedBytes);
  });
});

describe('adding a programme guide', () => {
  it('reads plain and gzipped XMLTV and says how long a guide it is', async () => {
    const tv = liveTv();
    expect((await tv.add('epg', `${base}/guide.xml`)).link).toMatchObject({ kind: 'epg', state: 'ok', summary: '7-day guide' });
    expect((await tv.add('epg', `${base}/guide.xml.gz`)).link).toMatchObject({ state: 'ok', summary: '3-day guide' });
    expect(tv.list().epg).toHaveLength(2);
  });

  it('refuses what is not a guide — a web page, a playlist, an empty <tv>', async () => {
    const tv = liveTv();
    const sentence = 'That doesn’t look like a programme guide — it should be an XMLTV file (.xml or .xml.gz).';
    routes.set('/page.xml', { body: '<html><body>Welcome</body></html>' });
    routes.set('/empty.xml', { body: '<?xml version="1.0"?><tv></tv>' });
    expect(await tv.add('epg', `${base}/page.xml`)).toEqual({ link: null, reason: sentence });
    expect(await tv.add('epg', `${base}/channels.m3u8`)).toEqual({ link: null, reason: sentence });
    expect(await tv.add('epg', `${base}/empty.xml`)).toEqual({ link: null, reason: sentence });
    expect(tv.list().epg).toEqual([]);
  });

  it('keeps only the programmes that can still be now or next before it looks again', async () => {
    const tv = liveTv();
    const { link } = await tv.add('epg', `${base}/guide.xml`);
    const cache = JSON.parse(readFileSync(join(root, 'live-tv', `${link!.id}.json`), 'utf8')) as { programmes: Record<string, unknown[]> };
    // A week of hourly programmes is 190 or so; the day and a half ahead is under forty.
    expect(cache.programmes['one.example']!.length).toBeGreaterThan(30);
    expect(cache.programmes['one.example']!.length).toBeLessThan(40);
    // A programme five days off is not kept at all.
    expect(cache.programmes['unlisted.example']).toBeUndefined();
  });
});

describe('what the player is given', () => {
  it('merges the playlists: each stream once, the playlist’s own numbers where they are free', async () => {
    const tv = liveTv();
    await tv.add('m3u', `${base}/channels.m3u8`);
    await tv.add('m3u', `${base}/second.m3u`);
    const channels = await tv.channels();
    expect(channels.map((c) => [c.number, c.name])).toEqual([
      [7, 'One'],
      [1, 'Two'],
      [2, 'Three'],
      // 7 was taken by the first playlist, so this one takes the next free number.
      [3, 'Seven Again'],
    ]);
    expect(channels[0]).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: 'One', number: 7, group: 'News', logo: 'https://img.example.com/one.png', url: 'https://tv.example.com/one.m3u8', tvgId: 'One.Example' });
    expect(new Set(channels.map((c) => c.id)).size).toBe(4);
    // The id belongs to the stream: the same address has the same id tomorrow.
    expect((await liveTv().channels())[0]!.id).toBe(channels[0]!.id);
  });

  it('gives now and next per tvg-id, matched whatever the case, with gaps left as gaps', async () => {
    const tv = liveTv();
    await tv.add('m3u', `${base}/channels.m3u8`);
    await tv.add('epg', `${base}/guide.xml`);
    const entries = await tv.guide();
    expect(entries).toEqual([
      {
        // Spelled as the playlist spells it, though the guide writes it in lower case.
        tvgId: 'One.Example',
        now: { title: 'Hour 08:00', start: '2026-10-03T08:00:00.000Z', stop: '2026-10-03T09:00:00.000Z', description: 'About it & more.' },
        next: { title: 'Hour 09:00', start: '2026-10-03T09:00:00.000Z', stop: '2026-10-03T10:00:00.000Z', description: 'About it & more.' },
      },
      { tvgId: 'two.example', now: null, next: { title: 'Later On Two', start: '2026-10-03T09:00:00.000Z', stop: '2026-10-03T10:00:00.000Z', description: null } },
    ]);
    // Time moves on without the guide being read again.
    clock.now = NOW + 2 * HOUR;
    const later = await tv.guide();
    expect(later[0]!.now?.title).toBe('Hour 10:00');
    expect(later.find((e) => e.tvgId === 'two.example')).toBeUndefined();
  });

  it('has no guide to give without channels that name a tvg-id', async () => {
    const tv = liveTv();
    await tv.add('epg', `${base}/guide.xml`);
    expect(await tv.guide()).toEqual([]);
  });

  it('serves both through the helper’s routes, in the contract’s shape', async () => {
    const tv = liveTv();
    await tv.add('m3u', `${base}/channels.m3u8`);
    await tv.add('epg', `${base}/guide.xml`);
    let helper: Helper | null = null;
    try {
      helper = await startHelper({
        port: 0,
        version: '0.1.0-test',
        token: 'live-tv-test-token-live-tv-test',
        workDir: join(root, 'helper'),
        toolsDir: join(root, 'helper', 'tools'),
        timeoutMs: 5_000,
        allowedHosts: [],
        allowedOrigins: [],
        loopbackPages: true,
        app: null,
        configured: {},
        log: () => undefined,
        tv: { channels: () => tv.channels(), guide: () => tv.guide() },
      });
      const page = { origin: 'http://127.0.0.1:4546' };
      const channels = HelperTvChannels.parse(await (await fetch(`${helper.origin}${HELPER_ROUTES.tvChannels}`, { headers: page })).json());
      expect(channels.channels.map((c) => c.name)).toEqual(['One', 'Two', 'Three']);
      const guideBody = HelperTvGuide.parse(await (await fetch(`${helper.origin}${HELPER_ROUTES.tvGuide}`, { headers: page })).json());
      expect(guideBody.guide.map((e) => e.tvgId)).toEqual(['One.Example', 'two.example']);
      expect((await fetch(`${helper.origin}${HELPER_ROUTES.tvChannels}`)).status).toBe(403);
    } finally {
      await helper?.close();
    }
  });
});

describe('looking again', () => {
  it('reads a link again after six hours and no sooner', async () => {
    const tv = liveTv();
    await tv.add('m3u', `${base}/channels.m3u8`);
    const read = (): number => requests.filter((r) => r === '/channels.m3u8').length;
    expect(read()).toBe(1);
    clock.now = NOW + REFRESH_MS - 60_000;
    await tv.refreshStale();
    expect(read()).toBe(1);
    clock.now = NOW + REFRESH_MS + 60_000;
    await tv.refreshStale();
    expect(read()).toBe(2);
    await tv.refreshStale();
    expect(read()).toBe(2);
  });

  it('keeps what a link last held when it stops answering, says so, and recovers', async () => {
    const tv = liveTv();
    const { link } = await tv.add('m3u', `${base}/channels.m3u8`);
    routes.delete('/channels.m3u8');
    const failed = await tv.refresh(link!.id);
    expect(failed.link).toMatchObject({ state: 'failed', summary: 'not found' });
    expect(failed.reason).toBe('That link answered, but there is no playlist there. Check the address and try again.');
    // While it was being read the window was told it was being checked.
    expect(changes.some((c) => c.m3u[0]?.state === 'checking')).toBe(true);
    // The channels it last held are still served.
    expect(await tv.channels()).toHaveLength(3);
    // A failed link is tried again in half an hour, not six.
    routes.set('/channels.m3u8', { body: PLAYLIST });
    clock.now = NOW + 31 * 60_000;
    await tv.refreshStale();
    expect(tv.list().m3u[0]).toMatchObject({ state: 'ok', summary: '3 channels', error: null });
  });

  it('starts with no links when what is stored is not something it wrote', () => {
    store.set('liveTv', { version: 99, links: 'nonsense' }, new Date(NOW).toISOString());
    expect(liveTv().list()).toEqual({ m3u: [], epg: [] });
  });
});
