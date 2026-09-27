/**
 * Setting the tools up without being asked.
 *
 * `ensureTools` looks at each tool in turn — yt-dlp first because it is the one that matters, then
 * FFmpeg because converting and tempo need it, then spotDL — and installs whatever is missing and
 * can be installed here, one at a time. A tool on PATH or given on the command line is the
 * person's own copy and is left alone; only the copies this helper set up are ever replaced.
 *
 * It remembers what it tried in `setup-state.json` beside the tools, so a failure is not retried in
 * a tight loop: a failed tool is tried again on the next start (callers pass `ignoreBackoff`) or
 * once six hours have passed. yt-dlp, which stops working when it falls behind the sites it reads,
 * is compared with the latest release at most once a day and replaced when it differs.
 *
 * `ToolProvisioner` wraps this with the state a server needs: one operation at a time, the live
 * per-tool status that health reports, and a manual install that queues behind an automatic one.
 * How those states read on screen is design rule UX-SETUP-001 (design/ux-rules.json).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HelperToolId, HelperToolSetup } from '@now-playing/contracts';
import { installTool, latestRelease, type InstallOptions, type InstallOutcome, type Release } from './install.js';
import { toolSource } from './sources.js';
import { installHint, resolveTool, type ResolvedTool, type ToolPaths } from './tools.js';

export type ToolSetup = HelperToolSetup;

/** yt-dlp first, then FFmpeg, then spotDL. */
export const SETUP_ORDER: readonly HelperToolId[] = ['yt-dlp', 'ffmpeg', 'spotdl'];
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;
export const STATE_FILE = 'setup-state.json';

interface ToolRecord {
  lastAttemptAt?: string;
  lastError?: string | null;
  lastUpdateCheckAt?: string;
  tag?: string | null;
}

type StateFile = { version: 1; tools: Partial<Record<HelperToolId, ToolRecord>> };

export interface EnsureOptions {
  toolsDir: string;
  configured: ToolPaths;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  now?: () => number;
  /** Retry failed tools now rather than waiting out the six hours: on start, and on "try again". */
  ignoreBackoff?: boolean;
  /** Only these tools (the manual install route names one). */
  only?: readonly HelperToolId[];
  /** Install even when present — a manual install of a tool that is already there replaces it. */
  force?: boolean;
  /** Whether jobs are running; a yt-dlp update waits for them rather than replacing a busy file. */
  busy?: () => boolean;
  onStatus?: (id: HelperToolId, setup: ToolSetup) => void;
  onInstalled?: (id: HelperToolId, outcome: InstallOutcome) => void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Injected by tests. */
  resolve?: (id: HelperToolId) => Promise<ResolvedTool>;
  install?: (id: HelperToolId, options: InstallOptions) => Promise<InstallOutcome>;
  release?: (repo: string) => Promise<Release>;
}

export interface EnsureResult {
  setup: Record<HelperToolId, ToolSetup>;
  /** What each install that was attempted said. */
  outcomes: Partial<Record<HelperToolId, InstallOutcome>>;
}

export async function ensureTools(options: EnsureOptions): Promise<EnsureResult> {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const log = options.log ?? (() => undefined);
  const resolve = options.resolve ?? ((id: HelperToolId) => resolveTool(id, { configured: options.configured, toolsDir: options.toolsDir }));
  const install = options.install ?? installTool;
  const release = options.release ?? ((repo: string) => latestRelease(repo, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.signal ? { signal: options.signal } : {}) }));
  const state = readState(options.toolsDir);
  const setup = {} as Record<HelperToolId, ToolSetup>;
  const outcomes: Partial<Record<HelperToolId, InstallOutcome>> = {};
  const report = (id: HelperToolId, value: ToolSetup): void => {
    setup[id] = value;
    options.onStatus?.(id, value);
  };

  const runInstall = async (id: HelperToolId): Promise<InstallOutcome> => {
    report(id, { state: 'installing', progress: 0 });
    let last = 0;
    const outcome = await install(id, {
      toolsDir: options.toolsDir,
      platform,
      arch,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (received, total) => {
        if (!total) return;
        const fraction = Math.min(0.99, received / total);
        // Only whole percentage steps, so a 200 MB download is a hundred updates and not a million.
        if (fraction - last >= 0.01) {
          last = fraction;
          report(id, { state: 'installing', progress: Math.floor(fraction * 100) / 100 });
        }
      },
    });
    outcomes[id] = outcome;
    return outcome;
  };

  for (const id of SETUP_ORDER) {
    if (options.only && !options.only.includes(id)) continue;
    if (options.signal?.aborted) break;
    const record: ToolRecord = (state.tools[id] ??= {});
    const tool = await resolve(id);
    const source = toolSource(id, platform, arch);

    if (tool.present && !options.force) {
      // Only a copy this helper set up is ever replaced; the person's own copies are theirs.
      if (id === 'yt-dlp' && tool.origin === 'installed' && source && due(record.lastUpdateCheckAt, UPDATE_CHECK_MS, now) && !options.busy?.()) {
        try {
          const latest = await release(source.repo);
          record.lastUpdateCheckAt = new Date(now()).toISOString();
          if (latest.tag && tool.version && latest.tag.trim() !== tool.version.trim()) {
            log(`yt-dlp ${tool.version} is behind ${latest.tag}; updating`);
            const outcome = await runInstall(id);
            record.lastAttemptAt = new Date(now()).toISOString();
            record.lastError = outcome.installed ? null : outcome.reason;
            if (outcome.installed) {
              record.tag = outcome.tag ?? latest.tag;
              options.onInstalled?.(id, outcome);
            } else log(`yt-dlp update refused: ${outcome.reason ?? 'unknown'}`);
          }
        } catch (error) {
          // No answer from GitHub is not a problem with the copy that works; ask again tomorrow.
          record.lastUpdateCheckAt = new Date(now()).toISOString();
          log(`could not check for a newer yt-dlp: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      report(id, { state: 'ready' });
      continue;
    }

    if (!source) {
      report(id, { state: 'unsupported', reason: installHint(id, false) });
      continue;
    }

    if (!options.ignoreBackoff && !options.force && record.lastError && !due(record.lastAttemptAt, RETRY_AFTER_MS, now)) {
      report(id, { state: 'failed', reason: record.lastError });
      continue;
    }

    log(`setting up ${id} in ${options.toolsDir}`);
    const outcome = await runInstall(id);
    record.lastAttemptAt = new Date(now()).toISOString();
    if (outcome.installed) {
      record.lastError = null;
      record.tag = outcome.tag ?? null;
      if (id === 'yt-dlp') record.lastUpdateCheckAt = record.lastAttemptAt;
      log(`set up ${id} ${outcome.version ?? ''}`.trim());
      report(id, { state: 'ready' });
      options.onInstalled?.(id, outcome);
    } else {
      record.lastError = outcome.reason ?? 'It could not be set up.';
      log(`could not set up ${id}: ${record.lastError}`);
      // A forced reinstall of a working tool that failed leaves the working tool working.
      report(id, tool.present ? { state: 'ready' } : { state: 'failed', reason: record.lastError });
    }
  }

  writeState(options.toolsDir, state, log);
  return { setup, outcomes };
}

function due(iso: string | undefined, afterMs: number, now: () => number): boolean {
  if (!iso) return true;
  const at = Date.parse(iso);
  return !Number.isFinite(at) || now() - at >= afterMs;
}

export function readState(toolsDir: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(join(toolsDir, STATE_FILE), 'utf8')) as Partial<StateFile>;
    if (parsed && typeof parsed === 'object' && parsed.tools && typeof parsed.tools === 'object') return { version: 1, tools: parsed.tools };
  } catch {
    // Missing or unreadable: start again. The worst case is one extra attempt.
  }
  return { version: 1, tools: {} };
}

function writeState(toolsDir: string, state: StateFile, log: (line: string) => void): void {
  try {
    mkdirSync(toolsDir, { recursive: true });
    const path = join(toolsDir, STATE_FILE);
    const part = `${path}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(part, path);
  } catch (error) {
    log(`could not record tool setup: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type ProvisionerOptions = Omit<EnsureOptions, 'ignoreBackoff' | 'only' | 'force' | 'onStatus'> & {
  /** Called whenever any tool's status changes, for anything that shows it. */
  onChange?: () => void;
};

/**
 * One tool operation at a time, and the status of each tool as the last operation left it.
 *
 * Before the first `ensure` the status is empty — "not looked at yet" — which is different from
 * "ready", and health reports it as such by leaving `setup` out.
 */
export class ToolProvisioner {
  private readonly setup: Partial<Record<HelperToolId, ToolSetup>> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private active: HelperToolId | null = null;
  private pending: Promise<EnsureResult> | null = null;

  constructor(private readonly options: ProvisionerOptions) {}

  status(): Partial<Record<HelperToolId, ToolSetup>> {
    return { ...this.setup };
  }

  /** The tool being installed right now, if any. */
  installing(): HelperToolId | null {
    return this.active;
  }

  /**
   * Install every missing tool. A call while one is already running shares it, except that a
   * "try again now" marks every failed tool as queued straight away, so the person sees it start.
   */
  ensure(options: { ignoreBackoff?: boolean } = {}): Promise<EnsureResult> {
    if (options.ignoreBackoff) {
      for (const id of SETUP_ORDER) if (this.setup[id]?.state === 'failed') this.setup[id] = { state: 'installing', progress: 0 };
      this.options.onChange?.();
    }
    // A routine check while one is running just shares it; "try again now" queues a fresh pass.
    if (this.pending && !options.ignoreBackoff) return this.pending;
    return this.run(options.ignoreBackoff ? { ignoreBackoff: true } : {});
  }

  /** A manual install of one tool, queued behind whatever is running. */
  async install(id: HelperToolId): Promise<InstallOutcome> {
    const result = await this.run({ only: [id], force: true, ignoreBackoff: true });
    return result.outcomes[id] ?? { installed: false, version: null, reason: `${id} could not be set up.` };
  }

  private run(extra: Pick<EnsureOptions, 'ignoreBackoff' | 'only' | 'force'>): Promise<EnsureResult> {
    const next = this.queue.then(() =>
      ensureTools({
        ...this.options,
        ...extra,
        onStatus: (id, setup) => {
          this.active = setup.state === 'installing' ? id : this.active === id ? null : this.active;
          this.setup[id] = setup;
          this.options.onChange?.();
        },
      }).finally(() => {
        this.active = null;
      }),
    );
    this.queue = next.catch(() => undefined);
    this.pending = next;
    void next.finally(() => {
      if (this.pending === next) this.pending = null;
    }).catch(() => undefined);
    return next;
  }
}
