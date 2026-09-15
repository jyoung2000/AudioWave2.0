/**
 * Finding the tools, and fetching yt-dlp when it is not there.
 *
 * The helper ships no binaries. It looks for what is already installed, and it can fetch yt-dlp
 * itself when asked — because "install Python, then install yt-dlp, then add it to PATH" is exactly
 * the setup this was meant to remove.
 *
 * **Why yt-dlp is not pinned.** Pinning a version is usually the careful choice and here it is the
 * opposite: yt-dlp works by keeping up with sites that change, so a pinned copy does not get
 * safer with age, it stops working. So the helper takes the current release and verifies it against
 * the `SHA2-256SUMS` file the project published *in that same release*. That is the same trust as
 * `pip install yt-dlp` — HTTPS to the project's own release — with the bytes checked rather than
 * assumed, and it is written down here rather than left for someone to discover.
 *
 * **Why spotDL is not fetched.** Its releases are not published in a shape this can verify the same
 * way, so the helper refuses to guess. It reports the one line that installs it and otherwise
 * treats it as absent — an absence with an instruction beats an unverified download.
 *
 * **Why FFmpeg is not fetched.** It is large, it is per-platform, and most machines have it. When
 * it is missing the helper says so and narrows what it offers: no format conversion, and yt-dlp is
 * asked for the best single audio stream rather than told to extract one.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { HelperTool, HelperToolId } from '@now-playing/contracts';

const run = promisify(execFile);

const YT_DLP_LATEST = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

export interface ToolPaths {
  'yt-dlp'?: string | undefined;
  spotdl?: string | undefined;
  ffmpeg?: string | undefined;
}

export interface ResolvedTool extends HelperTool {
  path: string | null;
}

export interface ResolveOptions {
  /** Explicit paths from the command line, which win over everything. */
  configured: ToolPaths;
  /** Where `install` puts things, and the second place to look. */
  toolsDir: string;
}

const INSTALL_HINTS: Record<HelperToolId, string> = {
  'yt-dlp': 'Not installed. The player can fetch it for you, or install it yourself: pipx install yt-dlp (or brew install yt-dlp, or winget install yt-dlp).',
  spotdl: 'Not installed. Install it with: pipx install spotdl — the helper does not fetch this one, because its releases cannot be checksum-verified the way yt-dlp’s can.',
  ffmpeg: 'Not installed. Without it nothing can be converted and yt-dlp takes whatever single audio stream a site offers. Install it with: brew install ffmpeg, apt install ffmpeg, or winget install ffmpeg.',
};

const BINARY_NAMES: Record<HelperToolId, string> = {
  'yt-dlp': process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
  spotdl: process.platform === 'win32' ? 'spotdl.exe' : 'spotdl',
  ffmpeg: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
};

export async function resolveTool(id: HelperToolId, options: ResolveOptions): Promise<ResolvedTool> {
  const installable = id === 'yt-dlp';
  const candidates: Array<{ path: string; origin: ResolvedTool['origin'] }> = [];
  const configured = options.configured[id];
  if (configured) candidates.push({ path: configured, origin: 'configured' });
  const installed = join(options.toolsDir, BINARY_NAMES[id]);
  if (existsSync(installed)) candidates.push({ path: installed, origin: 'installed' });
  const onPath = findOnPath(BINARY_NAMES[id]);
  if (onPath) candidates.push({ path: onPath, origin: 'path' });

  for (const candidate of candidates) {
    const version = await versionOf(candidate.path);
    // A path that will not answer `--version` is not a tool, whatever its name says.
    if (version === null) continue;
    return { id, present: true, version, origin: candidate.origin, installHint: null, installable, path: candidate.path };
  }
  return { id, present: false, version: null, origin: 'missing', installHint: INSTALL_HINTS[id], installable, path: null };
}

export async function resolveAll(options: ResolveOptions): Promise<Record<HelperToolId, ResolvedTool>> {
  const [ytDlp, spotdl, ffmpeg] = await Promise.all([resolveTool('yt-dlp', options), resolveTool('spotdl', options), resolveTool('ffmpeg', options)]);
  return { 'yt-dlp': ytDlp, spotdl, ffmpeg };
}

/** The first line of `--version`, which is all any of these three put there that is worth keeping. */
async function versionOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 256 });
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? '';
    return first.slice(0, 120) || null;
  } catch {
    return null;
  }
}

/**
 * PATH, walked by hand rather than shelled out to `which`, because a shell is the thing this
 * program is trying not to need.
 */
export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env['PATH'] ?? env['Path'] ?? '';
  const extensions = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      // On Windows the name already carries .exe; only try the others when it does not.
      const candidate = join(directory, binary.toLowerCase().endsWith(extension.toLowerCase()) ? binary : `${binary}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable directory on PATH — normal, and not this program's problem.
      }
    }
  }
  return null;
}

export interface InstallOutcome {
  installed: boolean;
  version: string | null;
  reason: string | null;
}

/**
 * Fetch the current yt-dlp release for this platform and verify it against the checksums published
 * beside it. Nothing is made executable until the digest matches.
 */
export async function installYtDlp(toolsDir: string, fetchImpl: typeof fetch = fetch): Promise<InstallOutcome> {
  const asset = ytDlpAsset();
  if (!asset) return { installed: false, version: null, reason: `There is no published yt-dlp build for ${process.platform}/${process.arch}. Install it with pipx instead.` };

  let binary: Uint8Array;
  let sums: string;
  try {
    const [binaryResponse, sumsResponse] = await Promise.all([fetchImpl(`${YT_DLP_LATEST}/${asset}`, { redirect: 'follow' }), fetchImpl(`${YT_DLP_LATEST}/SHA2-256SUMS`, { redirect: 'follow' })]);
    if (!binaryResponse.ok) return { installed: false, version: null, reason: `The download failed: ${binaryResponse.status} ${binaryResponse.statusText}` };
    if (!sumsResponse.ok) return { installed: false, version: null, reason: `The checksum file could not be read: ${sumsResponse.status}. Nothing was installed.` };
    binary = new Uint8Array(await binaryResponse.arrayBuffer());
    sums = await sumsResponse.text();
  } catch (error) {
    return { installed: false, version: null, reason: `The download could not be started: ${error instanceof Error ? error.message : String(error)}` };
  }

  const expected = digestFor(sums, asset);
  if (!expected) return { installed: false, version: null, reason: `The release publishes no checksum for ${asset}, so it was not installed.` };
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) return { installed: false, version: null, reason: `The downloaded file did not match its published checksum, so it was discarded.` };

  mkdirSync(toolsDir, { recursive: true });
  const target = join(toolsDir, BINARY_NAMES['yt-dlp']);
  const temporary = `${target}.part`;
  writeFileSync(temporary, binary);
  if (process.platform !== 'win32') chmodSync(temporary, 0o755);
  renameSync(temporary, target);

  const version = await versionOf(target);
  if (!version) return { installed: false, version: null, reason: 'The downloaded file was verified but would not report a version, so it is not being used.' };
  return { installed: true, version, reason: null };
}

/** The asset yt-dlp publishes for this platform, or null where it publishes none. */
export function ytDlpAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'win32') return arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform !== 'linux') return null;
  if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
  if (arch === 'arm') return 'yt-dlp_linux_armv7l';
  return arch === 'x64' ? 'yt-dlp_linux' : null;
}

/** `SHA2-256SUMS` is `<hex>  <name>` per line, which is the format every checksum tool writes. */
export function digestFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === asset) return match[1]!.toLowerCase();
  }
  return null;
}

export function publicTool(tool: ResolvedTool): HelperTool {
  // The path stays here. It is the one thing in this record that says something about the machine,
  // and docs/PRIVACY.md's rule is that a filesystem path never leaves the device that owns it.
  const { path: _path, ...rest } = tool;
  return rest;
}
