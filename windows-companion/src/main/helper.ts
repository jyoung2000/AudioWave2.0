/**
 * The local helper, embedded.
 *
 * `local-helper/` is the small program that lets a browser page do what a page cannot: run yt-dlp
 * or spotDL, and measure folders for a backup. Run on its own it serves the player too; inside the
 * companion it serves the API only, on loopback, to whichever player pastes its token. Starting it
 * here rather than shipping a second copy is what keeps the two in step — one resolver for the
 * tools, one estimator for the backup figures, the same routes the player already calls.
 *
 * The downloaders set themselves up (owner decision 2026-09-27; rule UX-SETUP-001): right after the
 * helper starts, every missing tool is fetched in the background into `<userData>\helper\tools`,
 * checked against the SHA-256 its project published, and reported here as it goes. Nothing waits
 * for it — not the window, not the helper — and a tool that lands is picked up at once.
 *
 * The token is made once and kept in the companion's database under the OS key store, like the hub
 * credential: a token in a plain file beside the database would be readable by anything that can
 * read the database.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHosts, resolveAll, resolveTool, startHelper, ToolProvisioner, type FinishedFile, type Helper, type HelperOptions } from '@now-playing/local-helper';
import type { BackupPart } from '@now-playing/local-helper/measure';
import type { HelperJob, OutputFormat } from '@now-playing/contracts';
import type { HelperStatus, HelperTool } from '../shared/ipc.js';
import type { CompanionStore } from './store.js';

const TOKEN_KEY = 'helperToken';
const TOOL_IDS = ['yt-dlp', 'spotdl', 'ffmpeg'] as const;
type ToolId = (typeof TOOL_IDS)[number];
/** How often setup looks again: retries a failure after its backoff, and keeps yt-dlp current. */
const RECHECK_MS = 60 * 60 * 1000;

/**
 * What the person is told when a tool cannot be set up automatically on this PC — the fallback for
 * setup's `unsupported` state, and for when the helper is not running at all.
 */
const ADVICE: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Install yt-dlp (winget install yt-dlp) or put yt-dlp.exe on the PATH. Sites change often; an out-of-date copy is the usual reason a download fails.',
  spotdl: 'Install spotDL with pipx install spotdl. It runs only on this PC, never on the hub.',
  ffmpeg: 'Install FFmpeg (winget install ffmpeg). Without it downloads keep their original format and cannot be converted.',
};

export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

export interface EmbeddedHelperOptions {
  store: CompanionStore;
  secretBox: SecretBox;
  version: string;
  dataDir: string;
  log: (line: string) => void;
  /** Read at start and on restart: the companion's backup folders and destination. */
  backup: () => { folders: Partial<Record<BackupPart, string[]>>; backupDir: string | null };
  /** A tool setup just installed, after the tool list has been re-read. */
  onToolInstalled?: (id: ToolId) => void;
  /** How setup reaches GitHub. Tests pass a fake; the app does not. */
  fetchImpl?: typeof fetch;
  /** Live TV for the player: the channels and now/next the Live TV tab keeps. */
  tv?: NonNullable<HelperOptions['tv']>;
  /**
   * Read at start (LAN) and whenever a job is made or could start (downloads), and on every setup
   * pass (automatic updates). Absent: loopback only, original format, one at a time, no limit.
   */
  settings?: () => HelperSettings;
  /** A download finished; the companion saves it where the person chose. Paths stay in this process. */
  onJobFinished?: (job: HelperJob, files: FinishedFile[]) => void;
}

export interface HelperSettings {
  lan: boolean;
  autoUpdate: boolean;
  downloads: { format: OutputFormat; concurrency: number; rateLimitKBps: number | null };
}

type Latest = NonNullable<HelperTool['latest']>;

export class EmbeddedHelper {
  private helper: Helper | null = null;
  private reason: string | null = null;
  private tools: HelperTool[] = [];
  private checkedAt: string | null = null;
  private starting: Promise<void> | null = null;
  private recheck: NodeJS.Timeout | null = null;
  /** What each tool's last Check found. Kept across restarts of the helper; cleared by an update. */
  private readonly latest = new Map<ToolId, Latest>();
  private readonly checking = new Set<ToolId>();
  /** Update or Install was chosen and has not finished. */
  private readonly pending = new Set<ToolId>();
  private lan = false;

  constructor(private readonly options: EmbeddedHelperOptions) {}

  /** The token, made on first use. Null only when the OS key store is unavailable. */
  token(): string | null {
    const { store, secretBox } = this.options;
    if (!secretBox.isEncryptionAvailable()) return null;
    const saved = store.get<string | null>(TOKEN_KEY, null);
    if (saved) {
      try {
        return secretBox.decryptString(Buffer.from(saved, 'base64'));
      } catch {
        // A token that no longer decrypts (a different Windows account, a moved profile) is replaced.
      }
    }
    const token = randomBytes(24).toString('base64url');
    store.set(TOKEN_KEY, secretBox.encryptString(token).toString('base64'), new Date().toISOString());
    return token;
  }

  async start(port: number): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startNow(port).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private toolsDir(): string {
    return join(this.options.dataDir, 'helper', 'tools');
  }

  private async startNow(port: number): Promise<void> {
    await this.stop();
    const token = this.token();
    if (!token) {
      this.reason = 'Windows could not protect the helper token, so the helper is not running.';
      return;
    }
    const workDir = join(this.options.dataDir, 'helper');
    const toolsDir = this.toolsDir();
    try {
      mkdirSync(toolsDir, { recursive: true });
      const backup = this.options.backup();
      const settings = this.options.settings;
      const lan = settings?.().lan ?? false;
      this.helper = await startHelper({
        lan,
        ...(settings
          ? {
              downloads: () => settings().downloads,
              autoUpdate: () => settings().autoUpdate,
            }
          : {}),
        ...(this.options.onJobFinished ? { onJobFinished: this.options.onJobFinished } : {}),
        port,
        version: this.options.version,
        token,
        workDir,
        toolsDir,
        timeoutMs: 900_000,
        allowedHosts: defaultHosts(),
        // The API only, for the player wherever this machine serves it from — the hub on
        // 127.0.0.1:4546, a dev server, the installed PWA. With no allowed origins and no page of
        // its own, the helper used to refuse every one of them, even health (403).
        allowedOrigins: [],
        loopbackPages: true,
        app: null,
        configured: {},
        log: this.options.log,
        backup,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...(this.options.tv ? { tv: this.options.tv } : {}),
        onToolInstalled: (id) => {
          // A copy setup just replaced is the latest it found; an older Check's answer no longer holds.
          if (!this.pending.has(id)) this.latest.delete(id);
          void this.checkTools().then(() => this.options.onToolInstalled?.(id));
        },
      });
      this.reason = null;
      this.lan = lan;
      this.options.log(`helper listening at ${this.helper.origin}${lan ? ', and to this network for the read-only routes' : ''}`);
      await this.checkTools();
      this.provision(true);
      this.recheck = setInterval(() => this.provision(false), RECHECK_MS);
      this.recheck.unref?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.helper = null;
      this.reason = /EADDRINUSE/.test(message) ? `Port ${port} is already in use on this PC. Choose another in Settings ▸ Network.` : `The helper could not start: ${message}`;
      this.options.log(this.reason);
    }
  }

  /** Set up whatever is missing, in the background. Never awaited by startup. */
  private provision(ignoreBackoff: boolean): void {
    const helper = this.helper;
    if (!helper) return;
    void helper.tools
      .ensure({ ignoreBackoff })
      .then(() => this.checkTools())
      .catch((err: unknown) => this.options.log(`tool setup stopped: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** "Try Again": start setup for every missing tool now and answer at once with it under way. */
  async installTools(): Promise<HelperStatus> {
    if (this.starting) await this.starting;
    this.provision(true);
    return this.status();
  }

  /** Restarted when the folders or the port change, so the estimate route sees the new folders. */
  async restart(port: number): Promise<void> {
    return this.start(port);
  }

  async stop(): Promise<void> {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    const helper = this.helper;
    this.helper = null;
    this.lan = false;
    if (helper) await helper.close().catch(() => undefined);
  }

  /** Whether downloads are running or waiting. */
  busy(): boolean {
    return this.helper?.jobs.busy() ?? false;
  }

  /** Where downloads are staged until the player (or the save folder) takes them. */
  stagingDir(): string {
    return join(this.options.dataDir, 'helper', 'jobs');
  }

  /**
   * Clear Cache: what finished downloads left in staging, and folders no job owns. Downloads still
   * running keep theirs. With no helper running, nothing can be using it, so it all goes.
   */
  async clearStaging(): Promise<void> {
    if (this.helper) {
      await this.helper.jobs.clearFinished();
      return;
    }
    rmSync(this.stagingDir(), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }

  /**
   * Check: ask the tool for its version again and its project for the latest release. A tool with
   * nothing to check against on this PC (no published build) says so instead.
   */
  async checkTool(id: ToolId): Promise<HelperStatus> {
    this.checking.add(id);
    try {
      const resolved = await resolveTool(id, { configured: {}, toolsDir: this.toolsDir() });
      this.tools = this.tools.map((tool) => (tool.id === id ? { ...tool, present: resolved.present, version: resolved.version ?? null, path: resolved.path, advice: resolved.present ? null : ADVICE[id], origin: resolved.origin } : tool));
      const provisioner = this.helper?.tools ?? new ToolProvisioner({ toolsDir: this.toolsDir(), configured: {}, ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}) });
      const found = await provisioner.check(id, { present: resolved.present, version: resolved.version ?? null, origin: resolved.origin });
      this.latest.set(id, { version: found.latest, updateAvailable: found.updateAvailable, reason: found.reason, checkedAt: found.checkedAt });
      this.checkedAt = new Date().toISOString();
    } finally {
      this.checking.delete(id);
    }
    return this.status();
  }

  /** Check All: every tool, one after another (three questions to GitHub, well inside its keyless limit). */
  async checkAll(): Promise<HelperStatus> {
    await this.checkTools();
    for (const id of TOOL_IDS) await this.checkTool(id);
    return this.status();
  }

  /**
   * Update or Install one tool with the verified installer. Returns at once with the tool shown as
   * being set up; its progress is in the status from then on. Refused, with the reason, while
   * downloads are using the tool or when the helper is not running.
   */
  async updateTool(id: ToolId): Promise<{ status: HelperStatus; reason: string | null }> {
    if (this.starting) await this.starting;
    const helper = this.helper;
    if (!helper) return { status: this.status(), reason: this.reason ?? 'The helper isn’t running, so nothing can be installed. Check the port in Settings ▸ Network.' };
    const present = this.tools.find((t) => t.id === id)?.present ?? false;
    if (present && helper.jobs.busy()) return { status: this.status(), reason: 'Downloads are running. Wait for them to finish, then update again.' };
    if (this.pending.has(id)) return { status: this.status(), reason: null };
    this.pending.add(id);
    void helper.tools
      .install(id)
      .then(async (outcome) => {
        this.options.log(outcome.installed ? `${id} ${present ? 'updated' : 'installed'}: ${outcome.version ?? ''}` : `${id} could not be ${present ? 'updated' : 'installed'}: ${outcome.reason ?? 'unknown'}`);
        await this.checkTools();
        // The helper's own install callback has told the companion (tempo pass, streaming) already.
        if (outcome.installed) this.latest.set(id, { version: this.latest.get(id)?.version ?? null, updateAvailable: false, reason: null, checkedAt: new Date().toISOString() });
      })
      .catch((err: unknown) => this.options.log(`${id} install stopped: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.pending.delete(id));
    return { status: this.status(), reason: null };
  }

  async checkTools(): Promise<HelperStatus> {
    const resolved = await resolveAll({ configured: {}, toolsDir: this.toolsDir() });
    this.tools = TOOL_IDS.map((id) => {
      const tool = resolved[id];
      return { id, present: tool.present, version: tool.version ?? null, path: tool.path, advice: tool.present ? null : ADVICE[id], origin: tool.origin };
    });
    this.checkedAt = new Date().toISOString();
    return this.status();
  }

  /** The resolved FFmpeg, for the tempo pass and the streaming sidecar; null when there is none. */
  ffmpegPath(): string | null {
    if (this.tools.length) return this.tools.find((t) => t.id === 'ffmpeg' && t.present)?.path ?? null;
    // Not looked up yet (the sidecar boots alongside the helper): a copy setup left last time counts.
    const installed = join(this.toolsDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    return existsSync(installed) ? installed : null;
  }

  /** The status once any start in flight has finished, so a first look does not see a half-started helper. */
  async settledStatus(): Promise<HelperStatus> {
    if (this.starting) await this.starting;
    return this.status();
  }

  status(): HelperStatus {
    const port = this.helper ? Number(new URL(this.helper.origin).port) : null;
    // Setup's live state rides on each tool, so progress shows between checks.
    const setup = this.helper?.tools.status() ?? {};
    const tools = this.tools.map((tool): HelperTool => {
      const extra = { ...(this.latest.has(tool.id) ? { latest: this.latest.get(tool.id)! } : {}), ...(this.checking.has(tool.id) ? { checking: true } : {}) };
      // Chosen but still queued behind setup: shown as under way from the moment it is pressed.
      const state = setup[tool.id]?.state === 'installing' || !this.pending.has(tool.id) ? setup[tool.id] : { state: 'installing' as const };
      if (!state) return { ...tool, ...extra };
      // A tool setup cannot fetch here keeps the manual advice; anything else it handles itself.
      return { ...tool, ...extra, setup: state, advice: state.state === 'unsupported' ? (tool.advice ?? ADVICE[tool.id]) : null };
    });
    return { running: this.helper !== null, port, origin: this.helper?.origin ?? null, reason: this.reason, tools, checkedAt: this.checkedAt, busy: this.busy(), lan: this.lan };
  }
}
