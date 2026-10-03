/**
 * Where each tool comes from, per platform — and the honest "nowhere" where no build is published.
 *
 * Pure data and pure functions, so both the resolver (which only needs to know whether a tool *can*
 * be set up here) and the installer (which does it) read the same table.
 *
 * Every source is a GitHub release of the project that makes the tool. The installer resolves the
 * release once through the REST API and takes the asset and its SHA-256 from that one answer, so a
 * release that lands mid-install cannot pair one version's file with another's checksum.
 */
import type { HelperToolId } from '@now-playing/contracts';

export interface ToolSource {
  /** `owner/name` on GitHub. */
  repo: string;
  /** Picks this platform's asset from a release's asset names. */
  asset: (names: readonly string[]) => string | null;
  /** A checksum file published in the same release, used only when the API gives no `digest`. */
  sums: string | null;
  /** A bare executable, or a zip whose `bin/` holds the executables. */
  kind: 'binary' | 'zip';
}

/** The asset yt-dlp publishes for this platform, or null where it publishes none. */
export function ytDlpAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'win32') return arch === 'ia32' ? 'yt-dlp_x86.exe' : arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform !== 'linux') return null;
  if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
  // armv7l is published only inside a zip now; rather than guess at its layout, it is not offered.
  return arch === 'x64' ? 'yt-dlp_linux' : null;
}

/** spotDL's standalone builds are named `spotdl-<version>-<platform>`; the version is not fixed. */
function spotdlPattern(platform: NodeJS.Platform, arch: string): RegExp | null {
  // The Windows build is x64; Windows on Arm runs it under emulation, so it is offered there too.
  if (platform === 'win32' && arch !== 'ia32') return /^spotdl-v?\d[\w.+-]*-win32\.exe$/i;
  if (platform === 'linux' && arch === 'x64') return /^spotdl-v?\d[\w.+-]*-linux$/i;
  if (platform === 'darwin') return /^spotdl-v?\d[\w.+-]*-darwin$/i;
  return null;
}

/**
 * FFmpeg only on Windows, where there is no package manager everyone has. On macOS and Linux the
 * system's own package is the better copy, and the helper says so rather than fetching one.
 */
function ffmpegAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== 'win32') return null;
  if (arch === 'x64') return 'ffmpeg-master-latest-win64-gpl.zip';
  if (arch === 'arm64') return 'ffmpeg-master-latest-winarm64-gpl.zip';
  return null;
}

export function toolSource(id: HelperToolId, platform: NodeJS.Platform = process.platform, arch: string = process.arch): ToolSource | null {
  if (id === 'yt-dlp') {
    const name = ytDlpAsset(platform, arch);
    return name ? { repo: 'yt-dlp/yt-dlp', asset: (names) => (names.includes(name) ? name : null), sums: 'SHA2-256SUMS', kind: 'binary' } : null;
  }
  if (id === 'spotdl') {
    const pattern = spotdlPattern(platform, arch);
    return pattern ? { repo: 'spotDL/spotify-downloader', asset: (names) => names.find((n) => pattern.test(n)) ?? null, sums: null, kind: 'binary' } : null;
  }
  const name = ffmpegAsset(platform, arch);
  return name ? { repo: 'BtbN/FFmpeg-Builds', asset: (names) => (names.includes(name) ? name : null), sums: 'checksums.sha256', kind: 'zip' } : null;
}

export function binaryName(id: HelperToolId, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${id}.exe` : id;
}

/** `SHA2-256SUMS` is `<hex>  <name>` per line, which is the format every checksum tool writes. */
export function digestFor(sums: string, asset: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === asset) return match[1]!.toLowerCase();
  }
  return null;
}
