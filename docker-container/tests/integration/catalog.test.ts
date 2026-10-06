/**
 * The music catalog inside a real hub (DEC-039): routes, auth, the NDJSON stream, the external
 * tool as YouTube/SoundCloud search and as the Spotify reader, settings, and a catalog download
 * through the queue with its tags.
 *
 * Outbound HTTP answers from the recorded fixtures in packages/domain/tests/fixtures/catalog; yt-dlp
 * and spotDL are Node stand-ins the hub starts exactly as it starts the real tools.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogAlbumDetail, CatalogResolveResult, CatalogSearchAggregate, CatalogSearchChunk, CatalogSettingsView, type CatalogTrack, type DownloadJob } from '@now-playing/contracts';
import { hubCatalogFetch } from '../../src/catalog/service.js';
import { toolEnvironment, toolScratchDir } from '../../src/media/tool-env.js';
import { ExternalToolAdapter } from '../../src/providers/adapters/external-tool.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const catalogFixtures = join(import.meta.dirname, '..', '..', '..', 'packages', 'domain', 'tests', 'fixtures', 'catalog');
const mediaFixtures = join(import.meta.dirname, '..', 'fixtures', 'media-metadata');
const fx = (name: string): unknown => JSON.parse(readFileSync(join(catalogFixtures, `${name}.json`), 'utf8'));

let root: string;
let hub: TestHub;
let device: { authorization: string };
let admin: { cookie: string; csrfToken: string };

function writeFakeYtDlp(dir: string): string {
  const path = join(dir, 'yt-dlp.mjs');
  writeFileSync(
    path,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'yt-dlp.calls'))}, JSON.stringify(args) + '\\n');
const last = args.at(-1);
if (last.startsWith('ytsearch')) process.stdout.write(${JSON.stringify(JSON.stringify(fx('ytdlp-ytsearch')))});
else if (last.startsWith('scsearch')) process.stdout.write(${JSON.stringify(JSON.stringify(fx('ytdlp-scsearch')))});
else { process.stderr.write('ERROR: unexpected ' + last + '\\n'); process.exit(1); }
`,
  );
  return path;
}

/** spotDL \`save\`: the recorded track, plus the ISRC and (with --preload) the YouTube Music match spotDL adds. */
function writeFakeSpotdl(dir: string): string {
  const path = join(dir, 'spotdl.mjs');
  const track = JSON.parse(readFileSync(join(mediaFixtures, 'spotdl-track.json'), 'utf8')) as Array<Record<string, unknown>>;
  writeFileSync(
    path,
    `import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'spotdl.calls'))}, JSON.stringify(args) + '\\n');
const url = args.at(-1);
if (url.includes('/playlist/')) { process.stderr.write('HTTP Error for GET to https://api.spotify.com/v1/playlists/x returned 404 due to Resource not found.\\n'); process.exit(1); }
const song = { ...${JSON.stringify(track[0])}, isrc: 'GBARL9300135', publisher: 'RCA Records Label', download_url: args.includes('--preload') ? 'https://music.youtube.com/watch?v=lYBUbBu4W08' : null };
writeFileSync(args[args.indexOf('--save-file') + 1], JSON.stringify([song]));
`,
  );
  return path;
}

const get = (url: string, headers: Record<string, string> = { authorization: device.authorization }) => hub.app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-catalog-'));
  const ytDlp = writeFakeYtDlp(root);
  const spotdl = writeFakeSpotdl(root);
  const ffmpeg = join(root, 'ffmpeg.mjs');
  writeFileSync(ffmpeg, "import { copyFileSync } from 'node:fs'; const a = process.argv.slice(2); copyFileSync(a[a.indexOf('-i') + 1], a.at(-1));\n");
  const data = join(root, 'data');
  const adapter = new ExternalToolAdapter(
    (id) => (id === 'yt-dlp' ? ytDlp : id === 'spotdl' ? spotdl : null),
    () => toolEnvironment(toolScratchDir(data), process.env),
    async () => ffmpeg,
    () => toolScratchDir(data),
  );
  hub = await createTestHub({ ffmpeg: { available: true, path: ffmpeg, version: '7.1', encoders: [] }, deps: { replaceAdapters: { 'external-tool': adapter } } });
  const answer = (match: string, name: string) => hub.fetch.on(match, () => ({ body: fx(name) }));
  answer('itunes.apple.com/search', 'itunes-search-song');
  answer('api.deezer.com/search/track', 'deezer-search-track');
  answer('api.deezer.com/search/artist', 'deezer-search-artist');
  answer('api.deezer.com/search/album', 'deezer-search-album');
  answer('api.deezer.com/track/isrc:USQX91300108', 'deezer-isrc');
  answer('api.deezer.com/track/isrc:', 'deezer-isrc-missing');
  answer('api.deezer.com/album/6575789/tracks', 'deezer-album-tracks');
  answer('api.deezer.com/album/6575789', 'deezer-album');
  answer('api.deezer.com/playlist/908622995/tracks', 'deezer-playlist-tracks');
  answer('api.deezer.com/playlist/908622995', 'deezer-playlist');
  answer('musicbrainz.org/ws/2/recording?query=', 'musicbrainz-recording-search');
  answer('musicbrainz.org/ws/2/isrc/', 'musicbrainz-isrc');
  answer('musicbrainz.org/ws/2/recording/', 'musicbrainz-recording');
  answer('musicbrainz.org/ws/2/release/', 'musicbrainz-release-labels');
  answer('lrclib.net/api/get', 'lrclib-get');
  answer('lrclib.net/api/search', 'lrclib-search');
  admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
}, 60_000);

afterAll(async () => {
  await hub?.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('catalog search on the hub', () => {
  it('streams NDJSON: a chunk per service as it answers, then done', async () => {
    const response = await get('/api/v1/catalog/search?q=daft%20punk%20get%20lucky&limit=3');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(response.headers['cache-control']).toBe('no-store');
    const chunks = response.body
      .trim()
      .split('\n')
      .map((line) => CatalogSearchChunk.parse(JSON.parse(line)));
    expect(chunks[0]!.type).toBe('results');
    const done = chunks.at(-1)!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') return;
    // yt-dlp, run through the external tool, is YouTube and SoundCloud search.
    expect(done.status.map((s) => [s.provider, s.state])).toEqual([
      ['itunes', 'ok'],
      ['deezer', 'ok'],
      ['musicbrainz', 'ok'],
      ['youtube', 'ok'],
      ['soundcloud', 'ok'],
    ]);
    const calls = readFileSync(join(root, 'yt-dlp.calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(calls.map((c) => c.at(-1))).toEqual(expect.arrayContaining(['ytsearch3:daft punk get lucky', 'scsearch3:daft punk get lucky']));
    expect(calls.every((c) => c[0] === '--ignore-config' && c.at(-2) === '--')).toBe(true);
  }, 30_000);

  it('answers once with ?stream=0, every row naming where it came from', async () => {
    const response = await get('/api/v1/catalog/search?q=get%20lucky&stream=0&sections=tracks&providers=deezer,itunes');
    expect(response.statusCode).toBe(200);
    const body = CatalogSearchAggregate.parse(response.json());
    expect(body.tracks.length).toBeGreaterThan(0);
    expect(body.tracks.every((t) => t.sources.length > 0)).toBe(true);
    expect(body.status.map((s) => s.provider)).toEqual(['itunes', 'deezer']);
  });

  it('is behind the same door as /search: a credential and the search:use scope', async () => {
    expect((await get('/api/v1/catalog/search?q=x', {})).statusCode).toBe(401);
    const narrow = await pairDevice(hub, admin, { scopes: ['library:read'] });
    expect((await get('/api/v1/catalog/search?q=x', { authorization: narrow.authorization })).statusCode).toBe(403);
    expect((await get('/api/v1/catalog/search?sections=tracks')).statusCode).toBe(400);
  });

  it('reaches only the catalog’s own hosts', async () => {
    await expect(hubCatalogFetch(hub.ctx.http)('https://evil.example/x', { signal: new AbortController().signal, headers: {} })).rejects.toThrow(/Blocked outbound URL/);
  });
});

describe('details, resolve, lyrics and enrichment on the hub', () => {
  it('an album with its tracks', async () => {
    const response = await get('/api/v1/catalog/album?id=deezer:6575789&limit=3');
    expect(response.statusCode).toBe(200);
    const body = CatalogAlbumDetail.parse(response.json());
    expect(body.album.label).toBe('Columbia');
    expect(body.collection.kind).toBe('album');
  });

  it('a Spotify song through spotDL, with its YouTube Music match', async () => {
    const response = await get(`/api/v1/catalog/resolve?url=${encodeURIComponent('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8')}`);
    expect(response.statusCode).toBe(200);
    const body = CatalogResolveResult.parse(response.json());
    expect(body.kind).toBe('track');
    expect(body.track!.isrc).toBe('GBARL9300135');
    expect(body.track!.sources.map((s) => [s.platform, s.matchedBy])).toEqual([
      ['spotify', 'link'],
      ['youtube-music', 'spotdl'],
    ]);
    const spotdl = readFileSync(join(root, 'spotdl.calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    expect(spotdl.at(-1)).toContain('--preload');
  }, 30_000);

  it('a Spotify playlist Spotify refuses: unavailable, with the reason', async () => {
    const body = CatalogResolveResult.parse((await get(`/api/v1/catalog/resolve?url=${encodeURIComponent('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')}`)).json());
    expect(body.kind).toBe('unavailable');
    expect(body.reason).toMatch(/private, or one Spotify made itself/);
  }, 30_000);

  it('a Deezer playlist with its covers and ref', async () => {
    const body = CatalogResolveResult.parse((await get(`/api/v1/catalog/resolve?url=${encodeURIComponent('https://www.deezer.com/playlist/908622995')}&limit=3`)).json());
    expect(body.collection!.ref).toMatchObject({ platform: 'deezer', kind: 'playlist', id: '908622995' });
    expect(body.collection!.covers.length).toBeGreaterThan(0);
  });

  it('lyrics and enrichment', async () => {
    const lyrics = (await get('/api/v1/catalog/lyrics?title=Get%20Lucky&artist=Daft%20Punk&album=Random%20Access%20Memories&durationSec=367')).json() as { found: boolean; synced: string };
    expect(lyrics.found).toBe(true);
    const enrich = (await get('/api/v1/catalog/enrich?isrc=usqx91300108&links=0')).json() as { genre: string; label: string; year: number };
    expect(enrich).toMatchObject({ genre: 'disco', label: 'Columbia', year: 2013 });
  }, 30_000);
});

describe('catalog settings and downloads', () => {
  it('settings: admin only, the SongLink key write-only, a switched-off service skipped', async () => {
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    expect((await get('/api/v1/catalog/settings')).statusCode).toBe(401);
    const before = CatalogSettingsView.parse((await hub.app.inject({ method: 'GET', url: '/api/v1/catalog/settings', headers })).json());
    expect(before).toEqual({ embedLyrics: true, providers: { itunes: true, deezer: true, musicbrainz: true, youtube: true, soundcloud: true }, odesliKeyConfigured: false });
    const put = await hub.app.inject({ method: 'PUT', url: '/api/v1/catalog/settings', headers, payload: { providers: { soundcloud: false }, odesliKey: 'secret-key-1' } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('secret-key-1');
    expect(put.json()).toMatchObject({ odesliKeyConfigured: true, providers: { soundcloud: false } });
    const search = CatalogSearchAggregate.parse((await get('/api/v1/catalog/search?q=lucky&stream=0&sections=tracks&providers=soundcloud')).json());
    expect(search.status[0]).toMatchObject({ provider: 'soundcloud', state: 'skipped' });
    await hub.app.inject({ method: 'PUT', url: '/api/v1/catalog/settings', headers, payload: { providers: { soundcloud: true }, odesliKey: '' } });
  });

  it('a catalog song goes through the download queue from its best source, with ISRC, genre, label, year and lyrics', async () => {
    const track: CatalogTrack = {
      id: 'deezer:67238735',
      title: 'Get Lucky',
      artist: 'Daft Punk',
      artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
      album: 'Random Access Memories',
      albumArtist: 'Daft Punk',
      durationMs: 367_000,
      isrc: 'USQX91300108',
      artworkUrl: 'https://cdn-images.dzcdn.net/images/cover/311bba0fc112d15f72c8b5a65f0456c1/1000x1000-000000-80-0-0.jpg',
      releaseDate: '2013-05-20',
      year: 2013,
      trackNumber: 8,
      discNumber: 1,
      bpm: 116.1,
      explicit: false,
      genre: null,
      label: null,
      sources: [
        { platform: 'deezer', id: '67238735', url: 'https://www.deezer.com/track/67238735', previewUrl: null, matchedBy: 'search' },
        { platform: 'youtube-music', id: '4D7u5KF7SP8', url: 'https://music.youtube.com/watch?v=4D7u5KF7SP8', previewUrl: null, matchedBy: 'search' },
      ],
      rank: 0,
    };
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/catalog/download', headers: { authorization: device.authorization }, payload: { track, authorization: { basis: 'user-owned', acknowledged: true }, target: { destination: 'hub' } } });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { job: DownloadJob; source: { platform: string; url: string }; embedded: Record<string, boolean> };
    expect(body.source).toMatchObject({ platform: 'youtube-music', url: 'https://music.youtube.com/watch?v=4D7u5KF7SP8' });
    expect(body.job.source).toMatchObject({ provider: 'external-tool', url: 'https://music.youtube.com/watch?v=4D7u5KF7SP8' });
    expect(body.job.source.tags).toMatchObject({ title: 'Get Lucky', artist: 'Daft Punk', featured: ['Pharrell Williams', 'Nile Rodgers'], isrc: 'USQX91300108', genre: 'disco', label: 'Columbia', date: '2013-05-20', trackNumber: 8 });
    expect(body.job.source.tags!.lyrics).toMatch(/^\[00:01\.00\]/);
    expect(body.embedded).toEqual({ isrc: true, genre: true, label: true, year: true, lyrics: true });
  }, 30_000);

  it('refuses a song that is only in a store, in words', async () => {
    const track = { id: 'apple-music:1', title: 'Nowhere Else', artist: 'Store Only', artists: [], album: null, albumArtist: null, durationMs: null, isrc: null, artworkUrl: null, releaseDate: null, year: null, trackNumber: null, discNumber: null, bpm: null, explicit: null, genre: null, label: null, sources: [{ platform: 'apple-music', id: '1', url: 'https://music.apple.com/us/song/1', previewUrl: null, matchedBy: 'search' }], rank: 0 };
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/catalog/download', headers: { authorization: device.authorization }, payload: { track, authorization: { basis: 'user-owned', acknowledged: true }, target: { destination: 'hub' } } });
    expect(response.statusCode).toBe(404);
    expect(response.json().detail).toMatch(/is in a store, but nowhere this hub can download from/);
  }, 30_000);
});
