/**
 * The hub calls its downloader working only when it really runs (Hermes, 2026-10-04).
 *
 * The container shipped a yt-dlp that existed and could not start: it unpacks itself into `$TMPDIR`,
 * and the container's `/tmp` is a small `noexec` tmpfs. The provider list still said "ok", because
 * nothing ever ran it. These tests run stand-in tools (Node scripts, which `versionOf` starts with
 * this Node) in the environment the download service uses.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExecutable } from '../../src/media/run-tool.js';
import { toolEnvironment, toolScratchDir } from '../../src/media/tool-env.js';
import { ExternalToolAdapter } from '../../src/providers/adapters/external-tool.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-tool-runs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function adapter(binary: string, env: NodeJS.ProcessEnv): ExternalToolAdapter {
  const instance = new ExternalToolAdapter(() => binary, () => env);
  instance.configure({ enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} });
  return instance;
}

describe('the tool environment', () => {
  it('gives the tool its own scratch folder on the data volume, and nothing else of the hub’s', () => {
    const scratch = toolScratchDir(root)!;
    expect(scratch).toBe(join(root, 'tmp', 'tools'));
    const env = toolEnvironment(scratch, { PATH: '/usr/bin', NP_DISCORD_TOKEN: 'secret', HOME: '/home/node' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: scratch });
  });

  it('on Windows also points TEMP and TMP there, and keeps SystemRoot', () => {
    const env = toolEnvironment('D:/data/tmp/tools', { Path: 'C:/Windows', SystemRoot: 'C:/Windows', TEMP: 'C:/t' }, 'win32');
    expect(env).toEqual({ PATH: 'C:/Windows', SystemRoot: 'C:/Windows', TEMP: 'D:/data/tmp/tools', TMP: 'D:/data/tmp/tools', TMPDIR: 'D:/data/tmp/tools' });
  });

  it('hands a tool FFmpeg’s full path, because `--ffmpeg-location ffmpeg` is read as a path and finds nothing', () => {
    // Found in the container on 2026-10-04: the hub knew FFmpeg as `ffmpeg`, and yt-dlp said "ffmpeg not found".
    const dir = dirname(process.execPath);
    const resolved = resolveExecutable(basename(process.execPath).replace(/\.exe$/i, ''), { PATH: dir, Path: dir });
    expect(resolved && isAbsolute(resolved)).toBe(true);
    expect(resolveExecutable('/usr/bin/ffmpeg')).toBe('/usr/bin/ffmpeg');
    expect(resolveExecutable(null)).toBeNull();
  });

  it('a hub with no disk leaves the default in place', () => {
    expect(toolScratchDir(':memory:')).toBeNull();
    expect(toolEnvironment(null, { PATH: '/bin' }, 'linux')).toEqual({ PATH: '/bin' });
  });
});

describe('external tool health', () => {
  it('a tool that exists and will not start is down, with a reason a person can act on', async () => {
    const broken = join(root, 'yt-dlp.mjs');
    writeFileSync(broken, "process.stderr.write('[PYI-68:ERROR] Failed to extract\\n'); process.exit(255);\n");
    const instance = adapter(broken, toolEnvironment(toolScratchDir(root), process.env));
    const health = await instance.health();
    expect(health.status).toBe('down');
    expect(health.lastError).toMatch(/would not start/);
    expect((await instance.test()).ok).toBe(false);
  });

  it('a tool that starts is ok — and is asked in the environment downloads use', async () => {
    const tool = join(root, 'yt-dlp.mjs');
    // Answers --version with where it was told to unpack itself.
    writeFileSync(tool, 'console.log(process.env.TMPDIR ?? "no TMPDIR");\n');
    const scratch = toolScratchDir(root)!;
    const instance = adapter(tool, toolEnvironment(scratch, process.env));
    expect((await instance.health()).status).toBe('ok');
    const tested = await instance.test();
    expect(tested.ok).toBe(true);
    expect(tested.message.startsWith(scratch)).toBe(true);
  });

  it('a tool that is not there yet is unconfigured, not down', async () => {
    const instance = adapter(join(root, 'missing-yt-dlp'), {});
    expect((await instance.health()).status).toBe('unconfigured');
  });
});

/**
 * Reading a link without a key. Stand-in tools record how they were called and answer with the
 * recorded real JSON (tests/fixtures/media-metadata), so what is checked is the hub's side: the
 * command line it builds, the environment it gives the tool, and what it makes of the answer.
 */
describe('reading a link through the tool', () => {
  const fixtures = join(import.meta.dirname, '..', 'fixtures', 'media-metadata');

  /** A stand-in yt-dlp: logs its arguments, prints a fixture. */
  function fakeYtDlp(fixture: string): { path: string; calls: () => string[][] } {
    const log = join(root, 'yt-dlp.calls');
    const path = join(root, 'fake-yt-dlp.mjs');
    writeFileSync(
      path,
      `import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(readFileSync(${JSON.stringify(join(fixtures, fixture))}, 'utf8'));
`,
    );
    return {
      path,
      calls: () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .map((l) => JSON.parse(l) as string[])
          : [],
    };
  }

  interface SpotdlSeen {
    args: string[];
    home: string;
    homeExisted: boolean;
    userprofile: string | undefined;
  }

  /** A stand-in spotDL: writes the fixture where --save-file says, and notes the home it was given. */
  function fakeSpotdl(fixture: string): { path: string; seen: () => SpotdlSeen } {
    const log = join(root, 'spotdl.seen');
    const path = join(root, 'fake-spotdl.mjs');
    writeFileSync(
      path,
      `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.HOME, homeExisted: existsSync(process.env.HOME), userprofile: process.env.USERPROFILE }));
writeFileSync(args[args.indexOf('--save-file') + 1], readFileSync(${JSON.stringify(join(fixtures, fixture))}, 'utf8'));
`,
    );
    return { path, seen: () => JSON.parse(readFileSync(log, 'utf8')) as SpotdlSeen };
  }

  function suite(tools: { 'yt-dlp'?: string; spotdl?: string }, ffmpeg: string | null = process.execPath): ExternalToolAdapter {
    const scratch = toolScratchDir(root)!;
    const instance = new ExternalToolAdapter(
      (id) => tools[id] ?? null,
      () => toolEnvironment(scratch, process.env),
      async () => ffmpeg,
      () => scratch,
    );
    instance.configure({ enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} });
    return instance;
  }

  it('a YouTube link: --ignore-config first, the URL last behind --, and the real title back', async () => {
    const tool = fakeYtDlp('youtube-big-buck-bunny.json');
    const instance = suite({ 'yt-dlp': tool.path });
    const result = await instance.resolve('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    expect(result).toMatchObject({ kind: 'track', title: 'Big Buck Bunny', artistName: 'Blender', durationMs: 635_000, year: 2014, canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
    const [args] = tool.calls();
    expect(args![0]).toBe('--ignore-config');
    expect(args!.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ']);
  });

  it('asks once, and answers the next request for the same link from what it was told', async () => {
    const tool = fakeYtDlp('soundcloud-flickermood.json');
    const instance = suite({ 'yt-dlp': tool.path });
    await instance.probe('https://soundcloud.com/forss/flickermood');
    const again = await instance.resolve('https://soundcloud.com/forss/flickermood');
    expect(again).toMatchObject({ title: 'Flickermood', artistName: 'Forss', genre: 'Electronic' });
    expect(tool.calls()).toHaveLength(1);
  });

  it('a list comes back as a playlist with its entries', async () => {
    const instance = suite({ 'yt-dlp': fakeYtDlp('soundcloud-set-soulhack.json').path });
    const probe = await instance.probe('https://soundcloud.com/forss/sets/soulhack');
    expect(probe).toMatchObject({ kind: 'playlist', title: 'Soulhack', listed: 11 });
    expect(await instance.resolve('https://soundcloud.com/forss/sets/soulhack')).toMatchObject({ kind: 'playlist', title: 'Soulhack', artistName: 'Forss' });
  });

  it('a Spotify link: spotDL, with the hub’s FFmpeg, in a new home of its own that is gone afterwards', async () => {
    const spotdl = fakeSpotdl('spotdl-track.json');
    const instance = suite({ spotdl: spotdl.path }, '/opt/ffmpeg');
    const result = await instance.resolve('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8');
    expect(result).toMatchObject({ kind: 'track', title: 'Never Gonna Give You Up', artistName: 'Rick Astley', albumName: 'Whenever You Need Somebody', year: 1987 });
    const seen = spotdl.seen();
    expect(seen.args.slice(-3)).toEqual(['save', '--', 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8']);
    expect(seen.args[seen.args.indexOf('--ffmpeg') + 1]).toBe('/opt/ffmpeg');
    expect(seen.homeExisted).toBe(true);
    expect(seen.userprofile).toBe(seen.home);
    expect(seen.home.startsWith(toolScratchDir(root)!)).toBe(true);
    expect(existsSync(seen.home), 'the home is removed after the run').toBe(false);
  });

  it('without spotDL a Spotify link is not something the hub can name', async () => {
    const instance = suite({});
    expect(await instance.resolve('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8')).toBeNull();
  });

  it('a tool that fails is reported, and not remembered as the answer', async () => {
    const broken = join(root, 'broken.mjs');
    writeFileSync(broken, "process.stderr.write('ERROR: [youtube] x: Video unavailable\\n'); process.exit(1);\n");
    const instance = suite({ 'yt-dlp': broken });
    await expect(instance.probe('https://youtu.be/x')).rejects.toThrow(/Video unavailable/);
    writeFileSync(broken, `process.stdout.write(${JSON.stringify(readFileSync(join(fixtures, 'youtube-big-buck-bunny.json'), 'utf8'))});\n`);
    await expect(instance.probe('https://youtu.be/x')).resolves.toMatchObject({ kind: 'track' });
  });

  it('never runs anything for a host that is not on the list', async () => {
    const tool = fakeYtDlp('youtube-big-buck-bunny.json');
    const instance = suite({ 'yt-dlp': tool.path });
    await expect(instance.probe('https://evil.example/watch?v=x')).rejects.toThrow(/not on a host/);
    expect(await instance.resolve('http://www.youtube.com/watch?v=x')).toBeNull();
    expect(tool.calls()).toHaveLength(0);
  });
});
