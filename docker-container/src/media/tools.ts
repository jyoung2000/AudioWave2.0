/**
 * The hub's own command-line tools: found where they already are, set up where they are not.
 *
 * Owner decision 2026-10-03: downloaders work without setup. The image ships yt-dlp, spotDL (owner
 * decision 2026-10-04, for open.spotify.com links) and FFmpeg, so
 * in a container this file only ever *finds* things. A hub run straight from Node — a Windows PC,
 * a NAS without Docker — has neither, and used to answer "Binary not found" until someone read the
 * documentation. Now it fetches them once, with the same verified installer the companion uses
 * (`@now-playing/domain/tool-install`): the publisher's release, checked against the SHA-256 the
 * publisher printed, asked for its version before it is moved into place.
 *
 * Nothing here decides *whether* a download may happen. That is still the rights basis on every
 * request and the host allowlist in the adapter; this only makes sure the tool exists.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { binaryName, findOnPath, installTool, type InstallOptions, type InstallOutcome } from '@now-playing/domain/tool-install';

export type HubToolId = 'yt-dlp' | 'ffmpeg' | 'spotdl';

/** spotDL last: it is the largest download, and it needs FFmpeg to do anything at all. */
const ORDER: readonly HubToolId[] = ['yt-dlp', 'ffmpeg', 'spotdl'];

/** Where the image puts its copies (docker-container/Dockerfile). */
const IMAGE_PATHS: Partial<Record<HubToolId, string>> = { 'yt-dlp': '/usr/local/bin/yt-dlp', spotdl: '/usr/local/bin/spotdl' };

interface ToolLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface HubToolsOptions {
  /** `<dataDir>/tools`, or null for a hub with no disk (tests), which sets nothing up. */
  toolsDir: string | null;
  log: ToolLog;
  imagePaths?: Partial<Record<HubToolId, string>>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  install?: (id: HubToolId, options: InstallOptions) => Promise<InstallOutcome>;
  /** Called once a tool has landed, so whoever cached "there is no FFmpeg" can look again. */
  onInstalled?: (id: HubToolId) => void;
}

export interface HubToolStatus {
  present: boolean;
  /** Why it is not here, in words an administrator can act on. */
  reason: string | null;
}

export class HubTools {
  private readonly abort = new AbortController();
  private readonly reasons = new Map<HubToolId, string>();
  private running: Promise<void> | null = null;

  constructor(private readonly options: HubToolsOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  /** The copy to run: the image's, then the hub's own, then whatever is on PATH. */
  locate(id: HubToolId): string | null {
    const shipped = (this.options.imagePaths ?? IMAGE_PATHS)[id];
    if (shipped && existsSync(shipped)) return shipped;
    const own = this.ownPath(id);
    if (own && existsSync(own)) return own;
    return findOnPath(binaryName(id, this.platform), this.options.env ?? process.env);
  }

  /** Where the hub would put its own copy, whether or not one is there. */
  ownPath(id: HubToolId): string | null {
    return this.options.toolsDir ? join(this.options.toolsDir, binaryName(id, this.platform)) : null;
  }

  status(): Record<HubToolId, HubToolStatus> {
    const one = (id: HubToolId): HubToolStatus => {
      const present = this.locate(id) !== null;
      return { present, reason: present ? null : (this.reasons.get(id) ?? null) };
    };
    return { 'yt-dlp': one('yt-dlp'), ffmpeg: one('ffmpeg'), spotdl: one('spotdl') };
  }

  /** Set up whatever is missing. Never throws: a hub with no network is still a hub. */
  ensure(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const toolsDir = this.options.toolsDir;
    if (!toolsDir) return;
    for (const id of ORDER) {
      if (this.abort.signal.aborted) return;
      if (this.locate(id)) continue;
      // FFmpeg has a published, checksummed build for Windows only; everywhere else the system
      // package is the right copy, and the image already carries it.
      if (id === 'ffmpeg' && this.platform !== 'win32') continue;
      try {
        const outcome = await (this.options.install ?? installTool)(id, { toolsDir, platform: this.platform, signal: this.abort.signal, ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}) });
        if (outcome.installed) {
          this.reasons.delete(id);
          this.options.log.info({ module: 'tools', tool: id, version: outcome.version, verified: outcome.verified ?? null }, 'set up a media tool');
          this.options.onInstalled?.(id);
        } else {
          this.reasons.set(id, outcome.reason ?? 'It could not be set up');
          this.options.log.warn({ module: 'tools', tool: id, reason: outcome.reason }, 'a media tool could not be set up');
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.reasons.set(id, reason);
        this.options.log.warn({ module: 'tools', tool: id, reason }, 'a media tool could not be set up');
      }
    }
  }

  /** Stop a download in flight; the staged file is the installer's to clean up. */
  close(): void {
    this.abort.abort();
  }
}
