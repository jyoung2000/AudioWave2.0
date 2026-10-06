/**
 * `/helper/v1/catalog/*` (DEC-039) over a real socket: the hub's catalog answers from this PC, for
 * the companion and the Android shell. The services answer from the recorded fixtures; yt-dlp and
 * spotDL are stubs that log their command lines.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogResolveResult, CatalogSearchAggregate, HELPER_CATALOG_ROUTES, type CatalogSearchChunk } from '@now-playing/contracts';
import { readCatalogStream } from '@now-playing/domain/catalog';
import { guardedCatalogFetch } from '../../src/catalog.js';
import { startHelper, type Helper } from '../../src/server.js';
import { STANDARD_ROUTES, fixture, fixtureFetch, type Route } from '../../../packages/domain/tests/unit/catalog-fixtures.js';

const TOKEN = 'catalog-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const PAGE = 'https://player.example';

const STUB = (dir: string): string => `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2026.08.19\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(args) + '\\n');
if (args[0] === 'save') {
  if (args[1].includes('/playlist/')) { process.stderr.write('HTTP Error for GET to https://api.spotify.com/v1/playlists/x returned 404 due to Resource not found.\\n'); process.exit(1); }
  writeFileSync(args[args.indexOf('--save-file') + 1], JSON.stringify([{ name: 'Never Gonna Give You Up', artists: ['Rick Astley'], album_name: 'Whenever You Need Somebody', duration: 213, date: '1987-11-16', url: args[1], cover_url: 'https://i.scdn.co/image/ab67616d0000b27315ebbedaacef61af244262a8', isrc: 'GBARL9300135', download_url: args.includes('--preload') ? 'https://music.youtube.com/watch?v=lYBUbBu4W08' : null }]));
  process.exit(0);
}
const last = args.at(-1);
if (last.startsWith('ytsearch')) process.stdout.write(${JSON.stringify(JSON.stringify(fixture('ytdlp-ytsearch')))});
else if (last.startsWith('scsearch')) process.stdout.write(${JSON.stringify(JSON.stringify(fixture('ytdlp-scsearch')))});
else { process.stderr.write('ERROR: Unsupported URL\\n'); process.exit(1); }
`;

let helper: Helper;
let root: string;
let stubDir: string;
let base: string;

const routes: Route[] = [[/api\.deezer\.com\/playlist\/908622995\/tracks/, 'deezer-playlist-tracks'], [/api\.deezer\.com\/playlist\/908622995/, 'deezer-playlist'], [/lrclib\.net\/api\/get/, 'lrclib-get'], ...STANDARD_ROUTES];

const get = (path: string, headers: Record<string, string> = { origin: PAGE }): Promise<Response> => fetch(`${base}${path}`, { headers });

function calls(): string[][] {
  const file = join(stubDir, 'calls.log');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as string[])
    : [];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-catalog-'));
  stubDir = join(root, 'stub');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'yt-dlp.mjs'), STUB(stubDir));
  writeFileSync(join(stubDir, 'spotdl.mjs'), STUB(stubDir));
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
    catalogFetch: fixtureFetch(routes).fetch,
  });
  const address = helper.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await helper.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the catalog on this PC', () => {
  it('streams a search as NDJSON, with yt-dlp searching YouTube and SoundCloud', async () => {
    const response = await get(`${HELPER_CATALOG_ROUTES.search}?q=daft%20punk%20get%20lucky&limit=3`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(response.headers.get('access-control-allow-origin')).toBe(PAGE);
    const chunks: CatalogSearchChunk[] = [];
    for await (const chunk of readCatalogStream(response.body!)) chunks.push(chunk);
    const done = chunks.at(-1)!;
    expect(done.type).toBe('done');
    expect(done.status.map((s) => s.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(calls().map((c) => c.at(-1))).toEqual(expect.arrayContaining(['ytsearch3:daft punk get lucky', 'scsearch3:daft punk get lucky']));
    expect(calls().every((c) => c[0] === '--ignore-config')).toBe(true);
  }, 30_000);

  it('answers once with ?stream=0', async () => {
    const body = CatalogSearchAggregate.parse(await (await get(`${HELPER_CATALOG_ROUTES.search}?q=get%20lucky&stream=0&providers=deezer`)).json());
    expect(body.tracks.length).toBeGreaterThan(0);
  });

  it('resolves a Spotify song through spotDL with its YouTube Music match, and says why a playlist cannot be read', async () => {
    const song = CatalogResolveResult.parse(await (await get(`${HELPER_CATALOG_ROUTES.resolve}?url=${encodeURIComponent('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8')}`)).json());
    expect(song.track!.sources.map((s) => [s.platform, s.matchedBy])).toEqual([
      ['spotify', 'link'],
      ['youtube-music', 'spotdl'],
    ]);
    expect(calls().some((c) => c[0] === 'save' && c.includes('--preload'))).toBe(true);
    const list = CatalogResolveResult.parse(await (await get(`${HELPER_CATALOG_ROUTES.resolve}?url=${encodeURIComponent('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')}`)).json());
    expect(list).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/private, or one Spotify made itself/) });
  }, 30_000);

  it('a Deezer playlist, lyrics and enrichment', async () => {
    const list = CatalogResolveResult.parse(await (await get(`${HELPER_CATALOG_ROUTES.resolve}?url=${encodeURIComponent('https://www.deezer.com/playlist/908622995')}&limit=3`)).json());
    expect(list.collection!.ref.kind).toBe('playlist');
    expect(((await (await get(`${HELPER_CATALOG_ROUTES.lyrics}?title=Get%20Lucky&artist=Daft%20Punk&album=Random%20Access%20Memories&durationSec=367`)).json()) as { found: boolean }).found).toBe(true);
    expect(await (await get(`${HELPER_CATALOG_ROUTES.enrich}?isrc=USQX91300108&links=0`)).json()).toMatchObject({ genre: 'disco', label: 'Columbia', year: 2013 });
  }, 30_000);

  it('refuses a page it has not vetted, and a request that is not a query, in words', async () => {
    expect((await get(`${HELPER_CATALOG_ROUTES.search}?q=x`, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await get(`${HELPER_CATALOG_ROUTES.search}?q=x`, {})).status).toBe(403);
    expect((await get(`${HELPER_CATALOG_ROUTES.search}?q=x&stream=0&providers=deezer`, { 'x-helper-token': TOKEN })).status).toBe(200);
    const bad = await get(`${HELPER_CATALOG_ROUTES.search}?sections=tracks`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('validation');
    expect((await get(`${HELPER_CATALOG_ROUTES.album}?id=youtube:abc`)).status).toBe(422);
  });
});

describe('the guarded fetch', () => {
  it('reaches only the catalog’s hosts, never this network, and re-checks every redirect', async () => {
    const seen: string[] = [];
    const fake = (async (input: URL | string) => {
      seen.push(String(input));
      return String(input).includes('itunes') ? new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }) : new Response('{}', { status: 200 });
    }) as typeof fetch;
    const init = { signal: new AbortController().signal, headers: {} };
    const publicName = async () => ['17.253.144.10'];
    await expect(guardedCatalogFetch(fake, publicName)('https://evil.example/x', init)).rejects.toThrow(/Blocked/);
    await expect(guardedCatalogFetch(fake, publicName)('http://api.deezer.com/x', init)).rejects.toThrow(/Blocked/);
    await expect(guardedCatalogFetch(fake, async () => ['192.168.1.10'])('https://api.deezer.com/x', init)).rejects.toThrow(/Blocked/);
    await expect(guardedCatalogFetch(fake, publicName)('https://itunes.apple.com/search', init)).rejects.toThrow(/Blocked/);
    expect(seen).toEqual(['https://itunes.apple.com/search']);
    expect((await guardedCatalogFetch(fake, publicName)('https://api.deezer.com/x', init)).status).toBe(200);
  });
});
