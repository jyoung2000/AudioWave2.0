/**
 * Setting a tool up: one release, one asset, one SHA-256, then a version check.
 *
 * **One release.** The installer asks the GitHub REST API for the latest release once and takes
 * everything from that answer — the asset's address and the digest GitHub computed for it. Fetching
 * "latest/download/<file>" and "latest/download/SHA2-256SUMS" as two requests (what this used to
 * do) can straddle a release and pair one version's file with the next one's checksum.
 *
 * **Verified or refused.** The digest is the `digest` field GitHub publishes for every release
 * asset. When an older release has none, a checksum file published *in that same release* is used
 * (yt-dlp's `SHA2-256SUMS`, BtbN's `checksums.sha256`). When there is neither, nothing is installed:
 * unverified bytes never become an executable here, whatever the cost in convenience.
 *
 * **Then it has to run.** Everything is staged in a folder of its own inside the tools folder,
 * asked for its version there, and only then renamed into place — so a download that fails any
 * step leaves the previous copy, if there was one, exactly as it was.
 *
 * Nothing here reaches the network except through `fetchImpl`, so tests hand it a fake GitHub.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { HelperToolId } from '@now-playing/contracts';
import { binaryName, digestFor, toolSource } from './sources.js';
import { versionOf } from './tools.js';
import { withZipFile, ZipError } from './zip.js';

export const USER_AGENT = 'NowPlaying-helper';
const API = 'https://api.github.com';

export interface InstallOutcome {
  installed: boolean;
  version: string | null;
  reason: string | null;
  /** The release tag that was installed (or tried), when one was read. */
  tag?: string | null;
}

export interface InstallOptions {
  toolsDir: string;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  signal?: AbortSignal;
  /** Overall limit, download included. Default ten minutes, twenty for FFmpeg's 200 MB archive. */
  timeoutMs?: number;
  onProgress?: (received: number, total: number | null) => void;
  /** Asks the staged file for its version. Injected by tests, whose "binaries" are a few bytes of text. */
  probe?: (id: HelperToolId, path: string) => Promise<string | null>;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** Lower-case hex SHA-256, from GitHub's `digest` field; null when the release predates it. */
  digest: string | null;
}

export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

const ReleaseBody = z.object({
  tag_name: z.string().min(1).max(200),
  assets: z
    .array(
      z.object({
        name: z.string().max(300),
        browser_download_url: z.string().max(2048),
        size: z.number().int().nonnegative(),
        digest: z.string().max(200).nullable().optional(),
      }),
    )
    .max(1000),
});

class Refusal extends Error {}

/** The latest release of `repo`, read once through the REST API. */
export async function latestRelease(repo: string, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<Release> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${API}/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    redirect: 'follow',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Refusal(`GitHub did not answer for ${repo}'s latest release (${response.status}${response.statusText ? ` ${response.statusText}` : ''}).`);
  const parsed = ReleaseBody.safeParse(await response.json());
  if (!parsed.success) throw new Refusal(`GitHub's answer for ${repo} was not a release this helper understands.`);
  return {
    tag: parsed.data.tag_name,
    assets: parsed.data.assets.map((asset) => {
      const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '');
      return { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: match ? match[1]!.toLowerCase() : null };
    }),
  };
}

/** Where the manual-install advice lives when there is nothing to fetch for this platform. */
function unsupportedReason(id: HelperToolId, platform: NodeJS.Platform, arch: string): string {
  if (id === 'ffmpeg') return `FFmpeg is not set up automatically on ${platform === 'darwin' ? 'macOS' : platform}. Install it with your package manager: brew install ffmpeg, apt install ffmpeg or dnf install ffmpeg.`;
  return `There is no published ${id} build for ${platform}/${arch}. Install it with pipx install ${id}.`;
}

export async function installTool(id: HelperToolId, options: InstallOptions): Promise<InstallOutcome> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const source = toolSource(id, platform, arch);
  if (!source) return { installed: false, version: null, reason: unsupportedReason(id, platform, arch), tag: null };

  const fetchImpl = options.fetchImpl ?? fetch;
  const limitMs = options.timeoutMs ?? (id === 'ffmpeg' ? 20 * 60_000 : 10 * 60_000);
  const timeout = AbortSignal.timeout(limitMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const probe = options.probe ?? ((tool: HelperToolId, path: string) => versionOf(path, tool, 60_000));

  let tag: string | null = null;
  let staging: string | null = null;
  try {
    if (signal.aborted) throw signal.reason;
    const release = await latestRelease(source.repo, { fetchImpl, signal });
    tag = release.tag;
    const assetName = source.asset(release.assets.map((a) => a.name));
    const asset = assetName ? release.assets.find((a) => a.name === assetName) : undefined;
    if (!asset) throw new Refusal(`${source.repo} ${release.tag} publishes no ${id} build for ${platform}/${arch}.`);
    assertGitHub(asset.url);

    // The expected digest is settled before a byte of the asset is downloaded.
    let expected = asset.digest;
    if (!expected && source.sums) {
      const sumsAsset = release.assets.find((a) => a.name === source.sums);
      if (sumsAsset) {
        assertGitHub(sumsAsset.url);
        const sumsResponse = await fetchImpl(sumsAsset.url, { redirect: 'follow', signal, headers: { 'user-agent': USER_AGENT } });
        if (!sumsResponse.ok) throw new Refusal(`The checksum file could not be read (${sumsResponse.status}). Nothing was installed.`);
        expected = digestFor(await sumsResponse.text(), asset.name);
      }
    }
    if (!expected) throw new Refusal(`${source.repo} ${release.tag} publishes no SHA-256 for ${asset.name}, so it was not installed.`);

    mkdirSync(options.toolsDir, { recursive: true });
    staging = mkdtempSync(join(options.toolsDir, '.staging-'));
    const download = join(staging, 'download.part');
    const actual = await downloadTo(fetchImpl, asset, download, signal, options.onProgress);
    if (actual !== expected) throw new Refusal(`The downloaded ${asset.name} did not match its published SHA-256, so it was discarded.`);

    // Stage the executables under their final names, ask the main one for its version, then move.
    const staged: Array<{ from: string; name: string }> = [];
    if (source.kind === 'binary') {
      const name = binaryName(id, platform);
      renameSync(download, join(staging, name));
      staged.push({ from: join(staging, name), name });
    } else {
      const wanted = ['ffmpeg', 'ffprobe'].map((tool) => binaryName(tool as HelperToolId, platform));
      withZipFile(download, (zip) => {
        for (const name of wanted) {
          const entry = zip.entries.find((e) => isBinEntry(e.name, name));
          if (!entry) throw new Refusal(`The FFmpeg archive has no bin/${name}, so nothing was installed.`);
          const part = join(staging!, `${name}.part`);
          writeFileSync(part, zip.read(entry));
          renameSync(part, join(staging!, name));
          staged.push({ from: join(staging!, name), name });
        }
      });
      rmSync(download, { force: true });
    }
    if (platform !== 'win32') for (const file of staged) chmodSync(file.from, 0o755);

    const main = staged.find((f) => f.name === binaryName(id, platform))!;
    const version = await probe(id, main.from);
    if (!version) throw new Refusal(`The downloaded ${id} was verified but would not report a version, so it is not being used.`);

    // The main executable goes last: the resolver looks for it, so it must not appear before its companions.
    for (const file of [...staged.filter((f) => f !== main), main]) {
      try {
        await renameWithRetry(file.from, join(options.toolsDir, file.name));
      } catch (error) {
        throw new Refusal(describeWriteError(id, error));
      }
    }
    return { installed: true, version, reason: null, tag };
  } catch (error) {
    return { installed: false, version: null, reason: explain(error, id, options.signal, timeout, limitMs), tag };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

/** Kept for callers of the old name: yt-dlp through the same verified path as everything else. */
export function installYtDlp(toolsDir: string, fetchImpl: typeof fetch = fetch): Promise<InstallOutcome> {
  return installTool('yt-dlp', { toolsDir, fetchImpl });
}

/** Stream the asset to disk, hashing as it goes, so a 200 MB archive is never held in memory. */
async function downloadTo(fetchImpl: typeof fetch, asset: ReleaseAsset, path: string, signal: AbortSignal, onProgress: InstallOptions['onProgress']): Promise<string> {
  const response = await fetchImpl(asset.url, { redirect: 'follow', signal, headers: { 'user-agent': USER_AGENT } });
  if (!response.ok || !response.body) throw new Refusal(`The download failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
  const header = Number(response.headers.get('content-length'));
  const total = Number.isFinite(header) && header > 0 ? header : asset.size > 0 ? asset.size : null;
  const hash = createHash('sha256');
  const file = await open(path, 'w');
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await file.write(value);
      received += value.byteLength;
      onProgress?.(received, total);
    }
  } finally {
    await file.close();
  }
  return hash.digest('hex');
}

function assertGitHub(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refusal('The release named a download address that is not a URL, so nothing was fetched.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') throw new Refusal(`The release pointed somewhere other than GitHub (${parsed.hostname}), so nothing was fetched.`);
}

/** Windows holds a running .exe open; antivirus holds a new one open for a moment after it lands. */
async function renameWithRetry(from: string, to: string, attempts = 4): Promise<void> {
  for (let i = 1; ; i += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * i));
    }
  }
}

export function describeWriteError(id: HelperToolId, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  if (['EBUSY', 'EPERM', 'EACCES'].includes(code)) return `The existing ${id} is in use and could not be replaced. Wait for running downloads to finish and try again.`;
  return `The verified ${id} could not be saved: ${error instanceof Error ? error.message : String(error)}`;
}

function explain(error: unknown, id: HelperToolId, outer: AbortSignal | undefined, timeout: AbortSignal, limitMs: number): string {
  if (error instanceof Refusal) return error.message;
  if (error instanceof ZipError) return `The FFmpeg archive could not be unpacked: ${error.message}`;
  if (timeout.aborted) return `Setting up ${id} took longer than ${Math.round(limitMs / 60_000)} minutes and was stopped. It will be tried again.`;
  if (outer?.aborted) return `Setting up ${id} was cancelled.`;
  return `The download could not be completed: ${error instanceof Error ? error.message : String(error)}`;
}

/** `bin/<file>` or `<top>/bin/<file>` — the layout of BtbN's builds, and nothing deeper. */
function isBinEntry(entryName: string, file: string): boolean {
  const parts = entryName.split(/[\\/]/);
  return parts.length >= 2 && parts.length <= 3 && parts[parts.length - 2]!.toLowerCase() === 'bin' && parts[parts.length - 1]!.toLowerCase() === file.toLowerCase();
}
