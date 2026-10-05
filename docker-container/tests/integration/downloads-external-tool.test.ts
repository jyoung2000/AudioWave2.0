/**
 * Downloads through the external tool, end to end inside a real hub: playlist links, tags, spotDL.
 *
 * The tools are stand-ins — Node scripts the hub starts exactly as it starts yt-dlp, spotDL and
 * FFmpeg (no shell, the same arguments, the same environment) — that answer with the recorded real
 * JSON (tests/fixtures/media-metadata) and write small files where they are told to. So what is
 * under test is the hub: one job per playlist entry, one rights basis for all of them, duplicates
 * skipped, the cap, the tool's own directory, and the FFmpeg pass that writes the tags.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOWNLOAD_BATCH_CAP, type DownloadBatchResult, type DownloadJob } from '@now-playing/contracts';
import { toolEnvironment, toolScratchDir } from '../../src/media/tool-env.js';
import { ExternalToolAdapter } from '../../src/providers/adapters/external-tool.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'media-metadata');
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8');

let root: string;
let hub: TestHub;
let device: { authorization: string };

/** A set of six entries: four distinct tracks, one twice, one off the allowlist and one private. */
function setJson(count?: number): string {
  const entries = count
    ? Array.from({ length: count }, (_, i) => ({ _type: 'url', url: `https://soundcloud.com/forss/track-${i}`, title: `Track ${i}`, uploader: 'Forss' }))
    : [
        { _type: 'url_transparent', url: 'https://soundcloud.com/forss/city-ports', album: 'Soulhack' },
        { _type: 'url', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', channel: 'Blender', duration: 635 },
        { _type: 'url_transparent', url: 'https://soundcloud.com/forss/city-ports', album: 'Soulhack' },
        { _type: 'url', url: 'https://evil.example/not-on-the-list', title: 'Elsewhere' },
        { _type: 'url', url: 'https://www.youtube.com/watch?v=private1', title: '[Private video]' },
        { _type: 'url_transparent', url: 'https://soundcloud.com/forss/flickermood', album: 'Soulhack' },
      ];
  return JSON.stringify({ _type: 'playlist', title: 'Soulhack', uploader: 'Forss', playlist_count: count ?? entries.length, webpage_url: 'https://soundcloud.com/forss/sets/soulhack', entries });
}

/**
 * yt-dlp: `--dump-single-json` prints the answer for the URL (honouring `--playlist-end`); a
 * download writes `media.opus` and `media.info.json` where `--output` points, and logs its arguments.
 */
function writeFakeYtDlp(dir: string, answers: Record<string, string>, opts: { twoFiles?: boolean } = {}): string {
  const path = join(dir, 'yt-dlp.mjs');
  writeFileSync(
    path,
    `import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'yt-dlp.calls'))}, JSON.stringify(args) + '\\n');
const url = args.at(-1);
const answers = ${JSON.stringify(answers)};
if (args.includes('--dump-single-json')) {
  const answer = answers[url];
  if (!answer) { process.stderr.write('ERROR: no answer for ' + url + '\\n'); process.exit(1); }
  const parsed = JSON.parse(answer);
  const end = Number(args[args.indexOf('--playlist-end') + 1]);
  if (Array.isArray(parsed.entries) && end) parsed.entries = parsed.entries.slice(0, end);
  process.stdout.write(JSON.stringify(parsed));
} else {
  const dir = dirname(args[args.indexOf('--output') + 1]);
  writeFileSync(join(dir, 'media.opus'), 'OggS fake opus for ' + url);
  writeFileSync(join(dir, 'media.info.json'), answers[url] ?? ${JSON.stringify(fixture('youtube-big-buck-bunny.json'))});
  ${opts.twoFiles ? "writeFileSync(join(dir, 'media2.m4a'), 'second');" : ''}
}
`,
  );
  return path;
}

/** spotDL: `save` writes the album or track answer; `download` writes `<id>.opus` and `song.spotdl`. */
function writeFakeSpotdl(dir: string): string {
  const path = join(dir, 'spotdl.mjs');
  writeFileSync(
    path,
    `import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, 'spotdl.calls'))}, JSON.stringify({ args, home: process.env.HOME }) + '\\n');
const url = args.at(-1);
const album = ${JSON.stringify(fixture('spotdl-album.json'))};
const track = ${JSON.stringify(fixture('spotdl-track.json'))};
if (args.includes('save')) {
  writeFileSync(args[args.indexOf('--save-file') + 1], url.includes('/album/') ? album : track);
} else {
  const out = dirname(args[args.indexOf('--output') + 1]);
  const id = url.split('/').pop();
  const song = JSON.parse(album).find((s) => s.url === url) ?? JSON.parse(track)[0];
  writeFileSync(join(out, id + '.opus'), 'OggS fake opus for ' + url);
  writeFileSync(args[args.indexOf('--save-file') + 1], JSON.stringify([song]));
}
`,
  );
  return path;
}

/** FFmpeg: copies its first input to its last argument and keeps the arguments and tags file it was given. */
function writeFakeFfmpeg(dir: string): string {
  const path = join(dir, 'ffmpeg.mjs');
  writeFileSync(
    path,
    `import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const inputs = args.flatMap((a, i) => (a === '-i' ? [args[i + 1]] : []));
const meta = inputs.find((p) => p.endsWith('.ffmeta'));
appendFileSync(${JSON.stringify(join(dir, 'ffmpeg.calls'))}, JSON.stringify({ args, meta: meta ? readFileSync(meta, 'utf8') : null }) + '\\n');
copyFileSync(inputs[0], args.at(-1));
`,
  );
  return path;
}

const calls = <T>(file: string): T[] =>
  existsSync(join(root, file))
    ? readFileSync(join(root, file), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as T)
    : [];

async function startHub(answers: Record<string, string>, opts: { twoFiles?: boolean; spotdl?: boolean } = {}): Promise<void> {
  const ytDlp = writeFakeYtDlp(root, answers, opts);
  const spotdl = opts.spotdl === false ? null : writeFakeSpotdl(root);
  const ffmpeg = writeFakeFfmpeg(root);
  const toolsData = join(root, 'data');
  const adapter = new ExternalToolAdapter(
    (id) => (id === 'yt-dlp' ? ytDlp : id === 'spotdl' ? spotdl : null),
    () => toolEnvironment(toolScratchDir(toolsData), process.env),
    async () => ffmpeg,
    () => toolScratchDir(toolsData),
  );
  hub = await createTestHub({ ffmpeg: { available: true, path: ffmpeg, version: '7.1', encoders: ['libmp3lame', 'aac', 'libopus', 'flac'] }, deps: { replaceAdapters: { 'external-tool': adapter } } });
  const admin = await hub.completeSetup();
  device = await pairDevice(hub, admin);
}

const batch = (url: string, basis = 'public-domain', format = 'original') =>
  hub.app.inject({ method: 'POST', url: '/api/v1/downloads/batch', headers: { authorization: device.authorization }, payload: { url, authorization: { basis, acknowledged: true }, target: { destination: 'hub', format } } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-dl-tool-'));
});

afterEach(async () => {
  await hub?.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('a playlist link', () => {
  it('becomes one job per entry, each with its own tags and the request’s one rights basis; duplicates and the rest are named', async () => {
    await startHub({ 'https://soundcloud.com/forss/sets/soulhack': setJson() });
    const response = await batch('https://soundcloud.com/forss/sets/soulhack');
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json() as DownloadBatchResult;
    expect(result.batch).toMatchObject({ kind: 'playlist', title: 'Soulhack', listed: 6, created: 3, cap: DOWNLOAD_BATCH_CAP, capped: false });
    expect(result.items.map((j) => j.source.url)).toEqual(['https://soundcloud.com/forss/city-ports', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'https://soundcloud.com/forss/flickermood']);
    expect(result.items.every((j) => j.authorization.basis === 'public-domain')).toBe(true);
    expect(result.items.map((j) => j.source.batch)).toEqual([0, 1, 2].map((index) => ({ id: result.batch.id, title: 'Soulhack', index, total: 3 })));
    // The listing's own title for a video, cleaned; a set entry with no title is named from its link until it runs.
    expect(result.items[1]!.source).toMatchObject({ title: 'Big Buck Bunny', artistName: 'Blender', tags: { title: 'Big Buck Bunny', durationMs: 635_000 } });
    expect(result.items[0]!.source.title).toBe('City Ports');
    expect(result.batch.skipped).toEqual([
      { url: 'https://soundcloud.com/forss/city-ports', title: 'City Ports', reason: 'duplicate' },
      { url: 'https://evil.example/not-on-the-list', title: 'Elsewhere', reason: 'not-allowed' },
      { url: 'https://www.youtube.com/watch?v=private1', title: '[Private video]', reason: 'unavailable' },
    ]);
    expect(result.message).toMatch(/3 downloads made; 3 skipped/);
    await hub.ctx.downloads.idle();
  });

  it('needs a rights basis the tool accepts, for the list and so for every entry — and makes nothing otherwise', async () => {
    await startHub({ 'https://soundcloud.com/forss/sets/soulhack': setJson() });
    const refused = await batch('https://soundcloud.com/forss/sets/soulhack', 'hub-hosted');
    expect(refused.statusCode).toBe(403);
    const missing = await hub.app.inject({ method: 'POST', url: '/api/v1/downloads/batch', headers: { authorization: device.authorization }, payload: { url: 'https://soundcloud.com/forss/sets/soulhack', target: { destination: 'hub' } } });
    expect(missing.statusCode).toBe(400);
    expect(hub.ctx.downloads.list()).toEqual([]);
    expect(calls('yt-dlp.calls'), 'nothing ran for a refused request').toEqual([]);
  });

  it(`takes at most ${DOWNLOAD_BATCH_CAP} entries, and says the list was longer`, async () => {
    await startHub({ 'https://soundcloud.com/forss/sets/long': setJson(DOWNLOAD_BATCH_CAP + 37) });
    const result = (await batch('https://soundcloud.com/forss/sets/long')).json() as DownloadBatchResult;
    expect(result.batch).toMatchObject({ listed: DOWNLOAD_BATCH_CAP + 37, created: DOWNLOAD_BATCH_CAP, capped: true });
    expect(result.items).toHaveLength(DOWNLOAD_BATCH_CAP);
    expect(result.message).toMatch(new RegExp(`lists ${DOWNLOAD_BATCH_CAP + 37} entries and one request takes at most ${DOWNLOAD_BATCH_CAP}`));
    const [listing] = calls<string[]>('yt-dlp.calls');
    expect(listing![listing!.indexOf('--playlist-end') + 1], 'the tool is asked for one more than the cap, no more').toBe(String(DOWNLOAD_BATCH_CAP + 1));
    await hub.ctx.downloads.stop();
  });

  it('asked for again, makes nothing new for entries already downloading or downloaded', async () => {
    await startHub({ 'https://soundcloud.com/forss/sets/soulhack': setJson() });
    await batch('https://soundcloud.com/forss/sets/soulhack');
    await hub.ctx.downloads.idle();
    const again = (await batch('https://soundcloud.com/forss/sets/soulhack')).json() as DownloadBatchResult;
    expect(again.batch.created).toBe(0);
    expect(again.batch.id).toBeNull();
    expect(again.batch.skipped.filter((s) => s.reason === 'duplicate')).toHaveLength(4);
    // The same tracks in another format are other files, so they are not duplicates.
    const asMp3 = (await batch('https://soundcloud.com/forss/sets/soulhack', 'public-domain', 'mp3')).json() as DownloadBatchResult;
    expect(asMp3.batch.created).toBe(3);
    await hub.ctx.downloads.idle();
  });

  it('is refused by the one-job endpoint, which says where to send it', async () => {
    await startHub({});
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/downloads',
      headers: { authorization: device.authorization },
      payload: { source: { provider: 'external-tool', providerTrackId: null, url: 'https://soundcloud.com/forss/sets/soulhack', locator: null, title: null, artistName: null }, authorization: { basis: 'public-domain', acknowledged: true }, target: { destination: 'hub', format: 'original' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/downloads\/batch/);
  });
});

describe('running a job through the tool', () => {
  it('runs yt-dlp in the job’s own directory, takes the one file it made, and tags it with FFmpeg', async () => {
    const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
    await startHub({ [url]: fixture('youtube-big-buck-bunny.json') });
    const result = (await batch(url)).json() as DownloadBatchResult;
    expect(result.batch).toMatchObject({ kind: 'track', id: null, created: 1 });
    await hub.ctx.downloads.idle();
    const job = hub.ctx.downloads.find(result.items[0]!.id) as DownloadJob;
    expect(job.state, job.error ?? '').toBe('completed');
    expect(job.source).toMatchObject({ title: 'Big Buck Bunny', artistName: 'Blender', tags: { date: '2014-11-10', license: 'Creative Commons Attribution license (reuse allowed)' } });

    const download = calls<string[]>('yt-dlp.calls').find((args) => !args.includes('--dump-single-json'))!;
    expect(download[0]).toBe('--ignore-config');
    expect(download.slice(-2)).toEqual(['--', url]);
    expect(download).toEqual(expect.arrayContaining(['--extract-audio', '--embed-metadata', '--embed-thumbnail', '--write-info-json']));

    const [ffmpeg] = calls<{ args: string[]; meta: string }>('ffmpeg.calls');
    expect(ffmpeg!.meta).toContain('title=Big Buck Bunny');
    expect(ffmpeg!.meta).toContain('artist=Blender');
    expect(ffmpeg!.meta).toContain('date=2014-11-10');
    expect(ffmpeg!.args).toEqual(expect.arrayContaining(['-c:a', 'copy']));
    expect(ffmpeg!.args.at(-1)).toMatch(/final\.opus$/);

    const blob = (hub.ctx.repos.downloads.find(job.id) as { outputPath: string }).outputPath;
    expect(blob).toMatch(/\.opus$/);
    expect(readFileSync(blob, 'utf8')).toContain('fake opus');
    expect(readdirSync(join(hub.dataDir, 'partial')).filter((n) => n.startsWith(job.id)), 'the job’s directory is gone').toEqual([]);
  });

  it('converts when asked, with the tags in the same pass', async () => {
    const url = 'https://soundcloud.com/forss/flickermood';
    await startHub({ [url]: fixture('soundcloud-flickermood.json') });
    const result = (await batch(url, 'public-domain', 'mp3')).json() as DownloadBatchResult;
    await hub.ctx.downloads.idle();
    const job = hub.ctx.downloads.find(result.items[0]!.id);
    expect(job.state, job.error ?? '').toBe('completed');
    const [ffmpeg] = calls<{ args: string[]; meta: string }>('ffmpeg.calls');
    expect(ffmpeg!.args).toEqual(expect.arrayContaining(['-c:a', 'libmp3lame', '-id3v2_version', '3']));
    expect(ffmpeg!.meta).toContain('genre=Electronic');
    expect((hub.ctx.repos.downloads.find(job.id) as { outputPath: string }).outputPath).toMatch(/\.mp3$/);
  });

  it('a tool that makes more than one file fails the job and says why', async () => {
    const url = 'https://soundcloud.com/forss/flickermood';
    await startHub({ [url]: fixture('soundcloud-flickermood.json') }, { twoFiles: true });
    const result = (await batch(url)).json() as DownloadBatchResult;
    await hub.ctx.downloads.idle();
    const job = hub.ctx.downloads.find(result.items[0]!.id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/produced 2 files/);
  });

  it('a Spotify album: one job per track from spotDL’s data, and each job runs spotDL for its one track', async () => {
    await startHub({});
    const response = await batch('https://open.spotify.com/album/6eUW0wxWtzkFdaEFsTJto6');
    expect(response.statusCode, response.body).toBe(201);
    const result = response.json() as DownloadBatchResult;
    expect(result.batch).toMatchObject({ kind: 'playlist', title: 'Whenever You Need Somebody', created: 10 });
    expect(result.items[0]!.source).toMatchObject({ url: 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8', title: 'Never Gonna Give You Up', artistName: 'Rick Astley', tags: { album: 'Whenever You Need Somebody', trackNumber: 1, date: '1987-11-16' } });
    await hub.ctx.downloads.idle();
    const jobs = hub.ctx.downloads.list();
    expect(jobs.filter((j) => j.state === 'completed').length, jobs.map((j) => j.error).join('\n')).toBe(10);
    const downloads = calls<{ args: string[]; home: string }>('spotdl.calls').filter((c) => c.args.includes('download'));
    expect(downloads).toHaveLength(10);
    expect(new Set(downloads.map((c) => c.home)).size, 'a new home every run').toBe(10);
    for (const call of downloads) expect(call.args.slice(-2)[0]).toBe('--');
    const [first] = calls<{ args: string[]; meta: string }>('ffmpeg.calls');
    expect(first!.meta).toMatch(/album=Whenever You Need Somebody/);
  });
});
