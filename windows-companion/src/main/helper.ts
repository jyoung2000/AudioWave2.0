/**
 * The local helper, embedded.
 *
 * `local-helper/` is the small program that lets a browser page do what a page cannot: run yt-dlp
 * or spotDL, and measure folders for a backup. Run on its own it serves the player too; inside the
 * companion it serves the API only, on loopback, to whichever player pastes its token. Starting it
 * here rather than shipping a second copy is what keeps the two in step — one resolver for the
 * tools, one estimator for the backup figures, the same routes the player already calls.
 *
 * The token is made once and kept in the companion's database under the OS key store, like the hub
 * credential: a token in a plain file beside the database would be readable by anything that can
 * read the database.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHosts, resolveAll, startHelper, type Helper } from '@now-playing/local-helper';
import type { BackupPart } from '@now-playing/local-helper/measure';
import type { HelperStatus, HelperTool } from '../shared/ipc.js';
import type { CompanionStore } from './store.js';

const TOKEN_KEY = 'helperToken';

/** What the person is told when a downloader is missing, in the companion's words. */
const ADVICE: Record<HelperTool['id'], string> = {
  'yt-dlp': 'Install yt-dlp (winget install yt-dlp) or put yt-dlp.exe on the PATH. Sites change often; an out-of-date copy is the usual reason a download fails.',
  spotdl: 'Install spotDL with pipx install spotdl. It runs only here, never in the container.',
  ffmpeg: 'Install ffmpeg (winget install ffmpeg). Without it downloads keep their original format and cannot be converted.',
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
}

export class EmbeddedHelper {
  private helper: Helper | null = null;
  private reason: string | null = null;
  private tools: HelperTool[] = [];
  private checkedAt: string | null = null;
  private starting: Promise<void> | null = null;

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

  private async startNow(port: number): Promise<void> {
    await this.stop();
    const token = this.token();
    if (!token) {
      this.reason = 'Windows could not protect the helper token, so the helper is not running.';
      return;
    }
    const workDir = join(this.options.dataDir, 'helper');
    const toolsDir = join(workDir, 'tools');
    try {
      mkdirSync(toolsDir, { recursive: true });
      const backup = this.options.backup();
      this.helper = await startHelper({
        port,
        version: this.options.version,
        token,
        workDir,
        toolsDir,
        timeoutMs: 900_000,
        allowedHosts: defaultHosts(),
        // The API only: any page that presents the token may use it. Same as the CLI's default.
        allowedOrigins: [],
        app: null,
        configured: {},
        log: this.options.log,
        backup,
      });
      this.reason = null;
      this.options.log(`helper listening at ${this.helper.origin}`);
      await this.checkTools();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.helper = null;
      this.reason = /EADDRINUSE/.test(message) ? `Port ${port} is already in use on this PC. Choose another in Settings ▸ Network.` : `The helper could not start: ${message}`;
      this.options.log(this.reason);
    }
  }

  /** Restarted when the folders or the port change, so the estimate route sees the new folders. */
  async restart(port: number): Promise<void> {
    return this.start(port);
  }

  async stop(): Promise<void> {
    const helper = this.helper;
    this.helper = null;
    if (helper) await helper.close().catch(() => undefined);
  }

  async checkTools(): Promise<HelperStatus> {
    const workDir = join(this.options.dataDir, 'helper');
    const resolved = await resolveAll({ configured: {}, toolsDir: join(workDir, 'tools') });
    this.tools = (['yt-dlp', 'spotdl', 'ffmpeg'] as const).map((id) => {
      const tool = resolved[id];
      return { id, present: tool.present, version: tool.version ?? null, path: tool.path, advice: tool.present ? null : ADVICE[id] };
    });
    this.checkedAt = new Date().toISOString();
    return this.status();
  }

  /** The status once any start in flight has finished, so a first look does not see a half-started helper. */
  async settledStatus(): Promise<HelperStatus> {
    if (this.starting) await this.starting;
    return this.status();
  }

  status(): HelperStatus {
    const port = this.helper ? Number(new URL(this.helper.origin).port) : null;
    return { running: this.helper !== null, port, origin: this.helper?.origin ?? null, reason: this.reason, tools: this.tools, checkedAt: this.checkedAt };
  }
}
