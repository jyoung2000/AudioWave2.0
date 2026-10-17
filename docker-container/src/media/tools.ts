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
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { binaryName, findOnPath, installTool, versionOf, type InstallOptions, type InstallOutcome } from '@now-playing/domain/tool-install';

export type HubToolId = 'yt-dlp' | 'ffmpeg' | 'spotdl';
export type HubToolState = 'missing' | 'checking' | 'installing' | 'ready' | 'failed';

/** Fixed words, safe to show an administrator: never stderr, paths or installer output. */
export const TOOL_REASONS = {
  probe: 'The file is there, but it did not answer its version check. Set it up again to repair it.',
  setup: 'It was set up, but the new copy did not run either. Check the hub logs, then try setting it up again.',
} as const;

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
  /** Runs a copy with its version flag; injected in tests. Defaults to a 30 s `versionOf` probe in this environment. */
  probe?: (path: string, id: HubToolId) => Promise<string | null>;
  /** Called once a tool has landed, so whoever cached "there is no FFmpeg" can look again. */
  onInstalled?: (id: HubToolId) => void;
}

export interface HubToolStatus {
  present: boolean;
  /** Verified readiness: only a probe that ran and answered says `ready`. */
  state: HubToolState;
  version: string | null;
  reason: string | null;
}

export class HubTools {
  private readonly abort = new AbortController();
  private readonly cache = new Map<HubToolId, { value: HubToolStatus; at: number }>();
  private running: Promise<void> | null = null;
  private healthRun: Promise<Record<HubToolId, HubToolStatus>> | null = null;
  /** How long a probed answer is believed before the next `health()` asks the tools again. */
  private static readonly HEALTH_TTL_MS = 300_000;

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
        const cached = this.cache.get(id)?.value;
        if (cached) return cached;
        const located = this.locate(id);
        // Not probed yet: a candidate is "checking"; nothing at all is "missing".
        return located ? { present: true, state: 'checking', version: null, reason: null } : { present: false, state: 'missing', version: null, reason: null };
      };
      return { 'yt-dlp': one('yt-dlp'), ffmpeg: one('ffmpeg'), spotdl: one('spotdl') };
    }

    /**
     * Verified readiness: each copy is asked its version, and only an answer counts as ready.
     * Coalesced so concurrent callers share one probe round, remembered for a short while, and
     * strictly read-only — a status check never installs anything.
     */
    health(): Promise<Record<HubToolId, HubToolStatus>> {
      // Startup setup owns the probes until it finishes; do not extract the same bundle twice.
      if (this.running) return this.running.then(() => this.health());
      if (this.healthFresh()) return Promise.resolve(this.cachedAll());
      this.healthRun ??= this.runHealth().finally(() => {
        this.healthRun = null;
      });
      return this.healthRun;
    }

    private healthFresh(): boolean {
      return ORDER.every((id) => {
        const entry = this.cache.get(id);
        return entry !== undefined && Date.now() - entry.at < HubTools.HEALTH_TTL_MS && entry.value.state !== 'checking' && entry.value.state !== 'installing';
      });
    }

    private cachedAll(): Record<HubToolId, HubToolStatus> {
      const one = (id: HubToolId): HubToolStatus => this.cache.get(id)!.value;
      return { 'yt-dlp': one('yt-dlp'), ffmpeg: one('ffmpeg'), spotdl: one('spotdl') };
    }

    private async runHealth(): Promise<Record<HubToolId, HubToolStatus>> {
      const out = {} as Record<HubToolId, HubToolStatus>;
      for (const id of ORDER) {
        // A setup in flight owns this answer: probing a file being replaced would call it missing.
        const inflight = this.cache.get(id)?.value;
        if (inflight?.state === 'installing') {
          out[id] = inflight;
          continue;
        }
        const located = this.locate(id);
        if (!located) {
          out[id] = { present: false, state: 'missing', version: null, reason: null };
        } else {
          const version = await this.safeProbe(located, id);
          out[id] = version ? { present: true, state: 'ready', version, reason: null } : { present: true, state: 'failed', version: null, reason: TOOL_REASONS.probe };
        }
        this.remember(id, out[id]);
      }
      return out;
    }

    /** The version a copy reports, cleaned to plain text; null when it would not say or blew up. */
    private async safeProbe(path: string, id: HubToolId): Promise<string | null> {
      try {
        // 60 s, the same allowance the installer and the local helper give: a 75 MB PyInstaller binary
// unpacking onto a slow data volume can outlive a shorter check and get called broken.
const probe = this.options.probe ?? ((p: string, tool: HubToolId) => versionOf(p, tool, 60_000, this.options.env));
        const raw = await probe(path, id);
              // eslint-disable-next-line no-control-regex -- tool output is exactly where control characters (BEL, ANSI, CR) appear
              const version = raw?.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 160);
        return version ? version : null;
      } catch {
        return null;
      }
    }

    private remember(id: HubToolId, value: HubToolStatus): void {
      this.cache.set(id, { value, at: Date.now() });
    }

  /** Set up whatever is missing. Never throws: a hub with no network is still a hub. */
  ensure(): Promise<void> {
    // Likewise, do not start a repair while a read-only probe is already using that executable.
    const health = this.healthRun;
    this.running ??= (health ? health.then(() => this.run()) : this.run()).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
      const toolsDir = this.options.toolsDir;
      if (!toolsDir) return;
      for (const id of ORDER) {
        if (this.abort.signal.aborted) return;
        // FFmpeg on anything but Windows: the system package is the right copy, so a broken one is
        // reported, never replaced, and a missing one is simply missing.
        const systemPackage = id === 'ffmpeg' && this.platform !== 'win32';
        const located = this.locate(id);
        // A copy the image shipped cannot be repaired by downloading another one: the image's copy
        // still wins resolution, and the installer's own verification gets no scratch environment
        // (InstallOptions has no env). Report it; never re-download 75 MB onto the host every boot.
        const fromImage = located !== null && (this.options.imagePaths ?? IMAGE_PATHS)[id] === located;
        if (located) {
          const version = await this.safeProbe(located, id);
          if (version) {
            this.remember(id, { present: true, state: 'ready', version, reason: null });
            continue;
          }
          if (systemPackage || fromImage) {
            this.remember(id, { present: true, state: 'failed', version: null, reason: TOOL_REASONS.probe });
            this.options.log.warn({ module: 'tools', tool: id }, fromImage ? 'the image-shipped copy did not answer its version check' : 'the system ffmpeg did not answer its version check');
            continue;
          }
          this.options.log.info({ module: 'tools', tool: id }, 'a copy is present but did not run; replacing it');
        } else if (systemPackage) {
          this.remember(id, { present: false, state: 'missing', version: null, reason: null });
          continue;
        }
        // Set up, or replace a copy that would not run: download, verify, then believe the probe,
        // not the installer's word.
        this.remember(id, { present: located !== null, state: 'installing', version: null, reason: null });
        try {
          const outcome = await (this.options.install ?? installTool)(id, { toolsDir, platform: this.platform, signal: this.abort.signal, ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}) });
          if (!outcome.installed) {
            this.remember(id, { present: located !== null, state: 'failed', version: null, reason: outcome.reason ?? 'It could not be set up' });
            this.options.log.warn({ module: 'tools', tool: id, reason: outcome.reason }, 'a media tool could not be set up');
            continue;
          }
          this.options.onInstalled?.(id);
          const target = this.locate(id) ?? this.ownPath(id);
          const version = target ? await this.safeProbe(target, id) : null;
          if (version) {
            this.remember(id, { present: true, state: 'ready', version, reason: null });
            this.options.log.info({ module: 'tools', tool: id, version, verified: outcome.verified ?? null }, 'set up a media tool');
          } else {
            // A copy that will not run is worse than none: the next look would call it present.
            // Remove one this setup produced; a copy that was already there stays for the record.
            // Only a managed copy this setup produced: the tool was missing and the file landed
            // in our own toolsDir. Anything else stays; health will say failed.
            if (located === null && target !== null && target === this.ownPath(id)) {
              try {
                rmSync(target, { force: true });
              } catch {
                /* leave it; health will say failed */
              }
            }
            this.remember(id, { present: located !== null && target !== null, state: 'failed', version: null, reason: TOOL_REASONS.setup });
            this.options.log.warn({ module: 'tools', tool: id }, 'a media tool was set up but does not run');
          }
        } catch (err) {
                  // The reason may be shown to a device: keep it to fixed words; the detail goes to the log.
                  const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
                  this.remember(id, { present: this.locate(id) !== null, state: 'failed', version: null, reason: 'It could not be set up' });
                  this.options.log.warn({ module: 'tools', tool: id, reason: detail }, 'a media tool could not be set up');
                }
      }
    }

  /** Non-blocking HTTP view: cold PyInstaller probes must not hold up the Player request. */
  snapshot(): Record<HubToolId, HubToolStatus> {
    const value = this.status();
    void this.health().catch(() => {
      this.options.log.warn({ module: 'tools' }, 'tool health refresh failed');
    });
    return value;
  }

  /** Stop a download in flight; the staged file is the installer's to clean up. */
  close(): void {
    this.abort.abort();
  }
}
