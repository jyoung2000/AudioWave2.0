/**
 * "Check for new versions of the companion" (Settings ▸ General).
 *
 * Once a day at most, and only while the setting is on, the companion asks GitHub's public API for
 * the project's latest release — no key, no account, nothing about this PC in the request but the
 * app's name and version in the User-Agent GitHub asks every client for. It never downloads or
 * installs anything: when a newer version is out the window says so, and Download opens the
 * project's release page in the browser. That page is the only thing it ever opens, whatever the
 * API answered (`RELEASES_PAGE`).
 */
import type { AppUpdate } from '../shared/ipc.js';
import type { CompanionStore } from './store.js';

export const RELEASES_API = 'https://api.github.com/repos/jyoung2000/AudioWave2.0/releases/latest';
/** What Download opens. Fixed here: an answer from the network never chooses what the shell opens. */
export const RELEASES_PAGE = 'https://github.com/jyoung2000/AudioWave2.0/releases/latest';
const STORE_KEY = 'appUpdate';
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;

interface Saved {
  latest: string | null;
  checkedAt: string | null;
  reason: string | null;
}

/** `v1.2.3`, `1.2.3-beta.1`, `airwave-1.2` → its numbers; null when there are none. */
export function versionNumbers(value: string): number[] | null {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Whether `latest` is newer than `current`. A pre-release of the same numbers is not newer. */
export function isNewer(latest: string, current: string): boolean {
  const a = versionNumbers(latest);
  const b = versionNumbers(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export interface UpdateCheckerOptions {
  store: CompanionStore;
  version: string;
  enabled: () => boolean;
  log: (line: string) => void;
  onChange?: (status: AppUpdate) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class UpdateChecker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<AppUpdate> | null = null;

  constructor(private readonly options: UpdateCheckerOptions) {}

  private saved(): Saved {
    const value = this.options.store.get<Partial<Saved> | null>(STORE_KEY, null) ?? {};
    return { latest: typeof value.latest === 'string' ? value.latest : null, checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null, reason: typeof value.reason === 'string' ? value.reason : null };
  }

  status(): AppUpdate {
    const saved = this.saved();
    const enabled = this.options.enabled();
    return {
      current: this.options.version,
      latest: saved.latest,
      available: enabled && saved.latest !== null && isNewer(saved.latest, this.options.version),
      checkedAt: saved.checkedAt,
      reason: saved.reason,
      enabled,
    };
  }

  /** Whether a day has passed since the last answer (or it has never asked). */
  due(): boolean {
    const { checkedAt } = this.saved();
    const at = checkedAt ? Date.parse(checkedAt) : Number.NaN;
    return !Number.isFinite(at) || (this.options.now?.() ?? Date.now()) - at >= UPDATE_EVERY_MS;
  }

  /** Asks now. A second call while one is running shares it. */
  check(): Promise<AppUpdate> {
    this.running ??= this.ask().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async ask(): Promise<AppUpdate> {
    const now = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    let next: Saved;
    try {
      const response = await fetchImpl(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `Airwave-Companion/${this.options.version}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) next = { latest: null, checkedAt: now, reason: 'No version has been published yet.' };
      else if (!response.ok) next = { ...this.saved(), checkedAt: now, reason: `GitHub didn’t answer (${response.status}). The companion will ask again tomorrow.` };
      else {
        const body = (await response.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
        const tag = typeof body.tag_name === 'string' ? body.tag_name.trim().slice(0, 60) : '';
        const version = versionNumbers(tag);
        next = version ? { latest: version.join('.'), checkedAt: now, reason: null } : { ...this.saved(), checkedAt: now, reason: 'The latest release doesn’t say which version it is.' };
      }
    } catch {
      next = { ...this.saved(), checkedAt: now, reason: 'GitHub couldn’t be reached. The companion will ask again tomorrow.' };
    }
    this.options.store.set(STORE_KEY, next, now);
    const status = this.status();
    if (status.available) this.options.log(`A newer companion is out: ${status.latest} (this is ${status.current}).`);
    this.options.onChange?.(status);
    return status;
  }

  /** Looks once now if due, then every hour for whether a day has passed. Only while the setting is on. */
  start(everyMs = 60 * 60 * 1000): void {
    this.stop();
    const tick = () => {
      if (this.options.enabled() && this.due()) void this.check();
    };
    tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
