/**
 * The installer, against a fake GitHub.
 *
 * Nothing here touches the network: `fetchImpl` is a table of URLs to answers, and every URL the
 * installer asks for is recorded so a test can prove it only ever spoke to GitHub. The downloaded
 * "binaries" are a few bytes of text, so the version probe is injected too — the real one would try
 * to run them.
 *
 * What is pinned is the part that must never regress: bytes whose SHA-256 does not match what the
 * release published are never installed, and neither are bytes with no published SHA-256 at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { HelperToolId } from '@now-playing/contracts';
import { describeWriteError, installTool, latestRelease } from '../../src/install.js';
import { toolSource } from '../../src/sources.js';
import { crc32 } from '../../src/zip.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface FakeAsset {
  name: string;
  bytes: Buffer;
  /** true (default) publishes the right digest; a string publishes that; false publishes none. */
  digest?: boolean | string;
}

function fakeGitHub(repo: string, tag: string, assets: FakeAsset[]) {
  const requested: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (url === `https://api.github.com/repos/${repo}/releases/latest`) {
      return Response.json({
        tag_name: tag,
        assets: assets.map((a) => ({
          name: a.name,
          size: a.bytes.length,
          browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${a.name}`,
          digest: a.digest === false ? null : typeof a.digest === 'string' ? a.digest : `sha256:${sha(a.bytes)}`,
        })),
      });
    }
    const asset = assets.find((a) => url === `https://github.com/${repo}/releases/download/${tag}/${a.name}`);
    if (asset) return new Response(asset.bytes, { headers: { 'content-length': String(asset.bytes.length) } });
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

let toolsDir: string;
const probed: string[] = [];
const probe = async (_id: HelperToolId, path: string): Promise<string | null> => {
  probed.push(path);
  return '2026.09.01';
};

beforeEach(() => {
  toolsDir = mkdtempSync(join(tmpdir(), 'np-install-test-'));
  probed.length = 0;
});

afterEach(() => {
  rmSync(toolsDir, { recursive: true, force: true });
});

const leftovers = (): string[] => readdirSync(toolsDir).filter((n) => n.startsWith('.staging') || n.endsWith('.part'));

describe('installing yt-dlp', () => {
  const binary = Buffer.from('pretend yt-dlp.exe');

  it('installs the asset when it matches the digest GitHub published for it', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary }, { name: 'yt-dlp_linux', bytes: Buffer.from('other') }]);
    const progress: Array<[number, number | null]> = [];
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe, onProgress: (r, t) => progress.push([r, t]) });
    expect(outcome).toMatchObject({ installed: true, version: '2026.09.01', reason: null, tag: '2026.09.01' });
    expect(readFileSync(join(toolsDir, 'yt-dlp.exe')).equals(binary)).toBe(true);
    // It answered its version flag before it was called installed.
    expect(probed).toHaveLength(1);
    expect(progress.at(-1)).toEqual([binary.length, binary.length]);
    expect(leftovers()).toEqual([]);
    // One release answer, one download, and only ever GitHub.
    expect(gh.requested.map((r) => r.url)).toEqual(['https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.09.01/yt-dlp.exe']);
    expect(gh.requested[0]!.headers).toMatchObject({ accept: 'application/vnd.github+json', 'user-agent': 'NowPlaying-helper' });
  });

  it('refuses bytes that do not match the published digest, and leaves nothing behind', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary, digest: `sha256:${'0'.repeat(64)}` }]);
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/did not match/);
    expect(existsSync(join(toolsDir, 'yt-dlp.exe'))).toBe(false);
    expect(probed).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it('falls back to the checksum file in the same release when there is no digest', async () => {
    const sums = `${sha(binary)}  yt-dlp.exe\n${'a'.repeat(64)}  yt-dlp_linux\n`;
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary, digest: false }, { name: 'SHA2-256SUMS', bytes: Buffer.from(sums), digest: false }]);
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(true);
    expect(gh.requested.map((r) => r.url)).toContain('https://github.com/yt-dlp/yt-dlp/releases/download/2026.09.01/SHA2-256SUMS');
  });

  it('refuses when the release publishes neither a digest nor a checksum file, before downloading anything', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary, digest: false }]);
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/no SHA-256/);
    expect(gh.requested).toHaveLength(1);
    expect(existsSync(join(toolsDir, 'yt-dlp.exe'))).toBe(false);
  });

  it('stops a download that runs past the size the release lists, and leaves nothing behind', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary }]);
    const inflated = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await gh.fetchImpl(input, init);
      return String(input).includes('/releases/download/') ? new Response(Buffer.concat([binary, Buffer.alloc(4096)])) : r;
    }) as typeof fetch;
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: inflated, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/ran past/);
    expect(existsSync(join(toolsDir, 'yt-dlp.exe'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a file that was verified but will not report a version', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary }]);
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe: async () => null });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/would not report a version/);
    expect(existsSync(join(toolsDir, 'yt-dlp.exe'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses a download address that is not GitHub', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes('/releases/latest')) return Response.json({ tag_name: 'x', assets: [{ name: 'yt-dlp.exe', size: 1, browser_download_url: 'https://evil.example/yt-dlp.exe', digest: `sha256:${'0'.repeat(64)}` }] });
      throw new Error(`unexpected ${String(input)}`);
    }) as typeof fetch;
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/GitHub/);
  });

  it('stops when asked to, and says so', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.09.01', [{ name: 'yt-dlp.exe', bytes: binary }]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await installTool('yt-dlp', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe, signal: controller.signal });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/cancelled/i);
  });

  it('reads the release once, through the API, and reports its tag', async () => {
    const gh = fakeGitHub('yt-dlp/yt-dlp', '2026.10.02', [{ name: 'yt-dlp.exe', bytes: binary }]);
    const release = await latestRelease('yt-dlp/yt-dlp', { fetchImpl: gh.fetchImpl });
    expect(release.tag).toBe('2026.10.02');
    expect(release.assets[0]).toMatchObject({ name: 'yt-dlp.exe', digest: sha(binary) });
  });
});

describe('installing spotDL', () => {
  const assets = (bytes: Buffer): FakeAsset[] => [
    { name: 'spotDL', bytes: Buffer.from('source') },
    { name: 'spotdl-4.5.2-darwin', bytes },
    { name: 'spotdl-4.5.2-linux', bytes },
    { name: 'spotdl-4.5.2-win32.exe', bytes },
  ];

  it('picks the Windows build by its versioned name and installs it as spotdl.exe', async () => {
    const bytes = Buffer.from('pretend spotdl');
    const gh = fakeGitHub('spotDL/spotify-downloader', 'v4.5.2', assets(bytes));
    const outcome = await installTool('spotdl', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(true);
    expect(readFileSync(join(toolsDir, 'spotdl.exe')).equals(bytes)).toBe(true);
    expect(gh.requested.at(-1)!.url).toMatch(/spotdl-4\.5\.2-win32\.exe$/);
  });

  it('picks the Linux and macOS builds by the same pattern', () => {
    const names = assets(Buffer.from('x')).map((a) => a.name);
    expect(toolSource('spotdl', 'linux', 'x64')!.asset(names)).toBe('spotdl-4.5.2-linux');
    expect(toolSource('spotdl', 'darwin', 'arm64')!.asset(names)).toBe('spotdl-4.5.2-darwin');
    expect(toolSource('spotdl', 'linux', 'arm64')).toBeNull();
  });

  it('refuses spotDL without a digest, since its releases publish no checksum file', async () => {
    const gh = fakeGitHub('spotDL/spotify-downloader', 'v4.5.2', [{ name: 'spotdl-4.5.2-win32.exe', bytes: Buffer.from('x'), digest: false }]);
    const outcome = await installTool('spotdl', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/no SHA-256/);
  });
});

describe('installing FFmpeg', () => {
  const ffmpeg = Buffer.from('pretend ffmpeg.exe '.repeat(100));
  const ffprobe = Buffer.from('pretend ffprobe.exe');

  function zipOf(entries: Array<[string, Buffer]>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [entryName, data] of entries) {
      const body = deflateRawSync(data);
      const name = Buffer.from(entryName);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(data), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      locals.push(local, name, body);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(8, 10);
      central.writeUInt32LE(crc32(data), 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, name);
      offset += 30 + name.length + body.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
  }

  const archive = zipOf([
    ['ffmpeg-master-latest-win64-gpl/LICENSE.txt', Buffer.from('GPL')],
    ['ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe', ffmpeg],
    ['ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe', ffprobe],
    ['ffmpeg-master-latest-win64-gpl/bin/ffplay.exe', Buffer.from('not wanted')],
  ]);

  it('takes ffmpeg.exe and ffprobe.exe out of the verified archive, and nothing else', async () => {
    const gh = fakeGitHub('BtbN/FFmpeg-Builds', 'latest', [{ name: 'ffmpeg-master-latest-win64-gpl.zip', bytes: archive }, { name: 'ffmpeg-master-latest-winarm64-gpl.zip', bytes: Buffer.from('arm') }]);
    const outcome = await installTool('ffmpeg', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed, outcome.reason ?? '').toBe(true);
    expect(readFileSync(join(toolsDir, 'ffmpeg.exe')).equals(ffmpeg)).toBe(true);
    expect(readFileSync(join(toolsDir, 'ffprobe.exe')).equals(ffprobe)).toBe(true);
    expect(existsSync(join(toolsDir, 'ffplay.exe'))).toBe(false);
    expect(leftovers()).toEqual([]);
    // What was verified is the archive — the thing GitHub publishes a digest for — and it is named,
    // so a person can compare it with the release page after the archive itself is gone.
    expect(outcome.verified).toEqual({ asset: 'ffmpeg-master-latest-win64-gpl.zip', sha256: sha(archive) });
  });

  it('uses the release’s checksums.sha256 when the asset has no digest', async () => {
    const sums = `${sha(archive)}  ffmpeg-master-latest-win64-gpl.zip\n`;
    const gh = fakeGitHub('BtbN/FFmpeg-Builds', 'latest', [{ name: 'ffmpeg-master-latest-win64-gpl.zip', bytes: archive, digest: false }, { name: 'checksums.sha256', bytes: Buffer.from(sums), digest: false }]);
    expect((await installTool('ffmpeg', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe })).installed).toBe(true);
  });

  it('picks the Arm build on Windows on Arm', () => {
    expect(toolSource('ffmpeg', 'win32', 'arm64')!.asset(['ffmpeg-master-latest-win64-gpl.zip', 'ffmpeg-master-latest-winarm64-gpl.zip'])).toBe('ffmpeg-master-latest-winarm64-gpl.zip');
  });

  it('refuses an archive without bin/ffmpeg.exe', async () => {
    const empty = zipOf([['top/README.txt', Buffer.from('nothing here')]]);
    const gh = fakeGitHub('BtbN/FFmpeg-Builds', 'latest', [{ name: 'ffmpeg-master-latest-win64-gpl.zip', bytes: empty }]);
    const outcome = await installTool('ffmpeg', { toolsDir, fetchImpl: gh.fetchImpl, platform: 'win32', arch: 'x64', probe });
    expect(outcome.installed).toBe(false);
    expect(outcome.reason).toMatch(/ffmpeg\.exe/);
    expect(leftovers()).toEqual([]);
  });

  it('does not fetch FFmpeg on macOS or Linux, and says what to do instead', async () => {
    const gh = fakeGitHub('BtbN/FFmpeg-Builds', 'latest', []);
    for (const platform of ['darwin', 'linux'] as const) {
      expect(toolSource('ffmpeg', platform, 'x64')).toBeNull();
      const outcome = await installTool('ffmpeg', { toolsDir, fetchImpl: gh.fetchImpl, platform, arch: 'x64', probe });
      expect(outcome.installed).toBe(false);
      expect(outcome.reason).toMatch(/package manager/);
    }
    expect(gh.requested).toEqual([]);
  });
});

describe('explaining a failed write', () => {
  it('says the tool is in use when Windows will not let it be replaced', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      expect(describeWriteError('yt-dlp', Object.assign(new Error('x'), { code }))).toMatch(/in use/);
    }
    expect(describeWriteError('yt-dlp', Object.assign(new Error('disk full'), { code: 'ENOSPC' }))).toMatch(/disk full/);
  });
});
