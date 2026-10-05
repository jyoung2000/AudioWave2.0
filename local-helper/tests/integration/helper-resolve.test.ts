/**
 * `GET /helper/v1/resolve` (NP-FIND-002), over a real socket, with stubs standing in for yt-dlp and
 * spotDL.
 *
 * The stubs answer with what the real tools said about real links on 2026-10-04 (trimmed to the
 * fields Airwave reads; `tests/fixtures/resolve/`), and write down every command line they were
 * given. So this proves both halves of the contract: what the helper hands a tool, and what it makes
 * of the answer — without the suite depending on a video still being online.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_ROUTES, HelperResolved } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';

const TOKEN = 'resolve-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const PAGE = 'https://player.example';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'resolve');

/**
 * One stub for both tools: `save` makes it spotDL, anything else yt-dlp. It logs its argv and its
 * HOME, then answers from the fixture its URL names.
 */
const STUB = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2026.08.19\\n'); process.exit(0); }
appendFileSync(join(here, 'calls.log'), JSON.stringify({ args, home: process.env.HOME ?? null }) + '\\n');
const fixture = (name) => readFileSync(join(here, name), 'utf8');
if (args[0] === 'save') {
  const url = args[1];
  const file = args[args.indexOf('--save-file') + 1];
  writeFileSync(file, fixture(url.includes('/album/') ? 'spotdl-album.json' : 'spotdl-track.json'));
  process.stdout.write('Saved\\n');
  process.exit(0);
}
const url = args[args.length - 1];
if (url.includes('fail')) { process.stderr.write('WARNING: ignore me\\nERROR: [youtube] fail: Video unavailable\\n'); process.exit(1); }
if (url.includes('partial')) {
  process.stdout.write(fixture('yt-dlp-youtube-playlist.json'));
  process.stderr.write('ERROR: [youtube] x: Private video\\n');
  process.exit(1);
}
const map = [['playlist?list=', 'yt-dlp-youtube-playlist.json'], ['/sets/', 'yt-dlp-soundcloud-set.json'], ['soundcloud.com/', 'yt-dlp-soundcloud-track.json'], ['watch?v=', 'yt-dlp-youtube-video.json']];
const hit = map.find(([needle]) => url.includes(needle));
if (!hit) { process.stderr.write('ERROR: Unsupported URL\\n'); process.exit(1); }
process.stdout.write(fixture(hit[1]));
`;

let helper: Helper;
let root: string;
let stubDir: string;
let base: string;

function calls(): Array<{ args: string[]; home: string | null }> {
  const file = join(stubDir, 'calls.log');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; home: string | null })
    : [];
}

function resolve(link: string, headers: Record<string, string> = { origin: PAGE }): Promise<Response> {
  return fetch(`${base}${HELPER_ROUTES.resolve}?url=${encodeURIComponent(link)}`, { headers });
}

async function resolved(link: string): Promise<HelperResolved> {
  const response = await resolve(link);
  expect(response.status, await response.clone().text()).toBe(200);
  // Whatever it says, it says in the contract's shape.
  return HelperResolved.parse(await response.json());
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-resolve-'));
  stubDir = join(root, 'stub');
  // The stub reads its fixtures from beside itself.
  mkdirSync(stubDir, { recursive: true });
  for (const name of readdirSync(FIXTURES)) copyFileSync(join(FIXTURES, name), join(stubDir, name));
  writeFileSync(join(stubDir, 'yt-dlp.mjs'), STUB);
  writeFileSync(join(stubDir, 'spotdl.mjs'), STUB);
  helper = await startHelper({
    port: 0,
    version: '1.0.0-test',
    token: TOKEN,
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 20_000,
    allowedHosts: ['www.youtube.com', 'soundcloud.com', 'open.spotify.com'],
    allowedOrigins: [PAGE],
    app: null,
    configured: { 'yt-dlp': join(stubDir, 'yt-dlp.mjs'), spotdl: join(stubDir, 'spotdl.mjs') },
    log: () => {},
  });
  const address = helper.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await helper.close();
  rmSync(root, { recursive: true, force: true });
});

describe('what a pasted link is', () => {
  it('reads a YouTube video: clean title and artist, the whole date, the duration and the art', async () => {
    const body = await resolved('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(body).toMatchObject({ source: 'youtube', kind: 'track', collection: null });
    expect(body.track).toMatchObject({
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      featured: [],
      durationSec: 213,
      date: '2009-10-25',
      year: 2009,
      artworkUrl: 'https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp',
    });
  });

  it('hands yt-dlp a describe-only command line with the URL last, behind --', async () => {
    const call = calls().find((c) => c.args.includes('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))!;
    expect(call.args[0]).toBe('--ignore-config');
    expect(call.args).toEqual(expect.arrayContaining(['--dump-single-json', '--flat-playlist', '--skip-download']));
    expect(call.args[call.args.indexOf('--playlist-end') + 1]).toBe('200');
    expect(call.args.at(-2)).toBe('--');
    expect(call.args.at(-1)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('reads a SoundCloud track with its genre and its release date, not its upload date', async () => {
    const body = await resolved('https://soundcloud.com/forss/flickermood');
    expect(body.track).toMatchObject({ title: 'Flickermood', artist: 'Forss', genre: 'Electronic', date: '2003-06-02', year: 2003 });
  });

  it('lists a playlist’s songs, each with its own address, and says the count and the cap', async () => {
    const body = await resolved('https://www.youtube.com/playlist?list=PLBB231211A4F62143');
    expect(body.kind).toBe('collection');
    expect(body.collection).toMatchObject({ title: 'Team Fortress 2 [2010 Version]', total: 29, cap: 200, capped: false });
    expect(body.collection!.entries).toHaveLength(29);
    for (const entry of body.collection!.entries) expect(entry.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    expect(body.collection!.entries[0]).toMatchObject({ durationSec: 629 });
  });

  it('lists a SoundCloud set by address, leaving the titles for each entry’s own lookup', async () => {
    const body = await resolved('https://soundcloud.com/the-concept-band/sets/the-royal-concept-ep');
    expect(body.collection).toMatchObject({ title: 'The Royal Concept EP', artist: 'The Royal Concept', total: 6, capped: false, date: '2012-07-28' });
    expect(body.collection!.entries[0]).toMatchObject({ url: 'https://soundcloud.com/the-concept-band/world-on-fire-1', title: null, album: 'The Royal Concept EP' });
  });

  it('reads a Spotify track through spotDL save, in a home of its own that is gone afterwards', async () => {
    const body = await resolved('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8');
    expect(body).toMatchObject({ source: 'spotify', kind: 'track' });
    expect(body.track).toMatchObject({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', durationSec: 213, date: '1987-11-16', trackNumber: 1, artworkUrl: expect.stringMatching(/^https:\/\/i\.scdn\.co\//) });
    const call = calls().find((c) => c.args[0] === 'save')!;
    // spotDL refuses `--`; the URL sits straight after the operation, where it is still only a URL.
    expect(call.args.slice(0, 2)).toEqual(['save', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8']);
    expect(call.args).toContain('--save-file');
    expect(call.home).toBeTruthy();
    expect(call.home!.startsWith(join(root, 'work'))).toBe(true);
    expect(existsSync(call.home!)).toBe(false);
  });

  it('reads a Spotify album in track order', async () => {
    const body = await resolved('https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6');
    expect(body.collection).toMatchObject({ title: 'Whenever You Need Somebody', artist: 'Rick Astley', total: 10, date: '1987-11-16' });
    expect(body.collection!.entries.map((e) => e.trackNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('remembers an answer, so asking twice runs the tool once', async () => {
    const before = calls().length;
    await resolved('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(calls().length).toBe(before);
  });

  it('lists what a playlist could describe when the site withholds some of it (yt-dlp exits 1)', async () => {
    const body = await resolved('https://www.youtube.com/playlist?list=partial');
    expect(body.kind).toBe('collection');
    expect(body.collection!.entries.length).toBeGreaterThan(0);
  });

  it('passes the tool’s own reason on when the site says no, and does not remember the failure', async () => {
    const first = await resolve('https://www.youtube.com/watch?v=fail');
    expect(first.status).toBe(502);
    expect(((await first.json()) as { message: string }).message).toMatch(/Video unavailable/);
    const before = calls().length;
    expect((await resolve('https://www.youtube.com/watch?v=fail')).status).toBe(502);
    expect(calls().length).toBe(before + 1);
  });
});

describe('who may ask, and what may be asked', () => {
  it('answers a vetted page without the token, and no page only with it', async () => {
    expect((await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {})).status).toBe(403);
    expect((await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { 'x-helper-token': TOKEN })).status).toBe(200);
    expect((await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { 'x-helper-token': 'wrong' })).status).toBe(403);
  });

  it('refuses a page it has not vetted', async () => {
    expect((await resolve('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('refuses a host off the allowlist, a private address and a non-https link before starting anything', async () => {
    const before = calls().length;
    for (const link of ['https://example.com/watch?v=a', 'https://127.0.0.1/watch?v=a', 'http://www.youtube.com/watch?v=a', 'file:///etc/passwd', '--exec=calc']) {
      const response = await resolve(link);
      expect(response.status, link).toBe(400);
    }
    expect((await fetch(`${base}${HELPER_ROUTES.resolve}`, { headers: { origin: PAGE } })).status).toBe(400);
    expect(calls().length).toBe(before);
  });

  it('never puts a path on this machine in an answer', async () => {
    const text = await (await resolve('https://www.youtube.com/watch?v=fail')).text();
    expect(text).not.toContain(root);
  });
});
