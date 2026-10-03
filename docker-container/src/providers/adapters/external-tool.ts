import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import { hostMatches, validateOutboundUrl } from '@now-playing/domain';
import type { AuthorizedDownload, DownloadContext, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

const run = promisify(execFile);

export interface ToolPreset {
  displayName: string;
  binary: string;
  /** `{output}` and `{url}` are substituted by the download service; nothing else is. */
  args: string[];
  allowedHosts: readonly string[];
  note: string;
}

/**
 * The command lines, written here rather than typed into an admin form.
 *
 * `--ignore-config` is not decoration: a configuration file left in the container's home directory
 * would otherwise be read and obeyed, and one of the flags it could add is `--exec`.
 *
 * Note what is *not* here. There is no `--extract-audio`, because a hub download job names one
 * output path and yt-dlp's audio extractor renames the file it was given. `-f bestaudio` writes
 * exactly where it was told, and the hub's own FFmpeg step already converts to whatever format was
 * asked for — reusing machinery that exists and is tested beats adding a rename to guess at.
 *
 * And there is no spotDL preset, though the tool is a good one. A hub download job is one track to
 * one path; spotDL turns a Spotify link into a *set* of tracks and wants a directory. That shape
 * belongs to the local helper, which gives each job its own directory and takes whatever appears —
 * so spotDL is supported there and honestly absent here rather than shipped broken.
 */
export const TOOL_PRESETS: Record<string, ToolPreset> = {
  'yt-dlp': {
    displayName: 'yt-dlp',
    binary: '/usr/local/bin/yt-dlp',
    args: ['--ignore-config', '--no-colors', '--newline', '--no-mtime', '--no-cache-dir', '--no-playlist', '--format', 'bestaudio/best', '--output', '{output}', '--', '{url}'],
    allowedHosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'soundcloud.com', 'on.soundcloud.com', 'bandcamp.com', 'archive.org'],
    note: 'Shipped in the image, and set up by the hub itself anywhere else. Keeping it current matters: yt-dlp works by tracking sites that change, so an old copy fails confusingly rather than safely.',
  },
};

/** The first line of `--version`, or null for anything that will not answer. */
async function toolVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 8000, maxBuffer: 1024 * 256 });
    return stdout.split(/\r?\n/)[0]?.trim().slice(0, 120) || null;
  } catch {
    return null;
  }
}

/**
 * Bridge to a command-line media tool. Ready without setup (owner decision 2026-10-03): with nothing configured it is
 * yt-dlp, run from the copy the image ships or the one the hub set up for itself (`media/tools.ts`). What made it safe
 * was never the switch: it never passes cookies or credentials to the tool, restricts it to allowlisted hosts, and only
 * runs it for downloads the requesting user has explicitly attributed to a rights basis (own content / licensed /
 * public domain). An administrator can still turn it off, or change it (Admin → Providers → External tool):
 *
 *   **A preset.** `extra.preset` names one of the tools below and fills in both the command and the hosts; leaving it
 *   empty means yt-dlp. The command line is written here — reviewed, in the repository — rather than typed into a web
 *   form where a stray `--exec` would be nobody's fault but everybody's problem.
 *
 *   **A template.** `extra.command`, such as `/usr/local/bin/mytool --no-playlist -o {output} {url}`, plus
 *   `extra.allowedHosts`. For a tool this file has never heard of.
 *
 * The image ships yt-dlp because a preset that names a binary nobody has is not a preset. It does not ship spotDL:
 * that needs a Python environment and a large dependency tree, and an operator who wants it can install it in a
 * derived image — the preset is here and will find it.
 */
export class ExternalToolAdapter extends BaseAdapter {
  readonly id = 'external-tool';

  /** `locate` answers with the copy of a preset's tool on this machine, when the hub knows of one. */
  constructor(private readonly locate: (tool: 'yt-dlp') => string | null = () => null) {
    super();
  }

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'External media tool', role: 'tool', authType: 'local', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['Ready without setup: yt-dlp, limited to the hosts on its list; an administrator can turn it off', 'Only for content you own or are licensed to download; the request records the rights basis', 'No cookies, credentials or DRM circumvention; the tool runs without a shell and with a timeout'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'restricted', creatorDownload: 'restricted', userOwnedDownload: 'restricted', groupSync: 'unsupported', reason: 'Only for allowlisted hosts and content you have rights to' });
  }

  override requiredConfig(): readonly string[] {
    // A preset supplies both, so demanding them as well would report a working setup as incomplete.
    return this.preset() ? [] : ['command', 'allowedHosts'];
  }

  /**
   * The preset in force. One that was named, when this build knows it; yt-dlp when nothing was
   * configured at all. A hand-written command, or a name this build has never heard of, means no
   * preset — the operator started something of their own and is asked to finish it.
   */
  preset(): ToolPreset | null {
    const name = (this.config.extra['preset'] ?? '').trim();
    if (name) return TOOL_PRESETS[name] ?? null;
    return (this.config.extra['command'] ?? '').trim() ? null : TOOL_PRESETS['yt-dlp']!;
  }

  override allowedHosts(): readonly string[] {
    const configured = (this.config.extra['allowedHosts'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    // A preset's hosts are the floor, not the ceiling: an operator may add, never silently lose them.
    const preset = this.preset();
    return preset ? [...new Set([...preset.allowedHosts, ...configured])] : configured;
  }

  commandTemplate(): string[] {
    const configured = (this.config.extra['command'] ?? '').split(/\s+/).filter(Boolean);
    if (configured.length) return configured;
    const preset = this.preset();
    if (!preset) return [];
    const named = (this.config.extra['binary'] ?? '').trim();
    const binary = named || (preset === TOOL_PRESETS['yt-dlp'] ? this.locate('yt-dlp') : null) || preset.binary;
    return [binary, ...preset.args];
  }

  timeoutMs(): number {
    const n = Number(this.config.extra['timeoutSeconds'] ?? 600);
    return (Number.isFinite(n) && n > 0 ? n : 600) * 1000;
  }

  /**
   * Report what is actually installed, not merely that a path exists.
   *
   * A file called `yt-dlp` that will not answer `--version` is not yt-dlp, and for this tool in
   * particular the *version* is the interesting part: a copy that is a year old does not fail
   * safely, it fails confusingly, on site after site. So the answer carries it.
   */
  override async test(): Promise<ProviderTestResult> {
    const [binary] = this.commandTemplate();
    if (!binary) return { ok: false, latencyMs: null, message: 'No command configured, and the preset named is not one this hub knows' };
    if (!existsSync(binary)) {
      const own = this.preset() !== null && !(this.config.extra['binary'] ?? '').trim();
      return { ok: false, latencyMs: null, message: own ? `${this.preset()!.displayName} was not found on this hub yet. The hub sets it up by itself when it can reach github.com; restart the hub to try again.` : `Binary not found: ${binary}` };
    }
    if (!this.allowedHosts().length) return { ok: false, latencyMs: null, message: 'No allowed hosts configured' };
    const started = Date.now();
    const version = await toolVersion(binary);
    const latencyMs = Date.now() - started;
    if (!version) return { ok: false, latencyMs, message: `${binary} did not answer --version, so it is not being used` };
    return { ok: true, latencyMs, message: `${version} — ${this.allowedHosts().length} host(s) allowlisted` };
  }

  private allowed(url: string): URL | null {
    const check = validateOutboundUrl(url, { allowedHosts: this.allowedHosts(), allowedSchemes: ['https:'] });
    if (!check.ok || !check.url) return null;
    return this.allowedHosts().some((h) => hostMatches(check.url!.hostname, h)) ? check.url : null;
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const u = this.allowed(urlOrId.trim());
    if (!u) return null;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname);
    return result({ provider: this.id, kind: 'track', providerId: u.toString(), title: slug || u.hostname, artistName: u.hostname, canonicalUrl: u.toString(), capabilities: this.capabilities(), attribution: `Source: ${u.hostname}`, accessState: 'restricted' });
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const u = this.allowed(id);
    if (!u) return null;
    if (!['user-owned', 'licensed', 'public-domain', 'purchased-export', 'creator-download'].includes(context.basis)) return null;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'download');
    return { kind: 'external-tool', url: u.toString(), filename: slug || 'download', basis: context.basis };
  }
}
