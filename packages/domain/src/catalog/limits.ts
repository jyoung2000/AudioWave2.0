/**
 * Caches, pacing and provider health: what keeps a search from hammering a free service, and what
 * lets the status line say "Deezer is resting until 14:02" instead of failing the same way twice.
 */
import type { CatalogProviderId, CatalogSourceStatus } from '@now-playing/contracts';
import { CatalogHttpError } from './http.js';

export type Now = () => number;

/**
 * A small in-memory cache of promises with a time to live. A pending answer is shared, so two
 * searches for the same thing make one request; a failure is forgotten at once, so the next asks
 * again.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 200,
    private readonly now: Now = Date.now,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit && at - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.entries.delete(key);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { at, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CatalogHttpError('The search was cancelled', 'aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CatalogHttpError('The search was cancelled', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * One request at a time, at least `intervalMs` apart: MusicBrainz asks for no more than one a
 * second from an application, and gets it. Waiting callers are served in order.
 */
export class Pacer {
  private chain: Promise<void> = Promise.resolve();
  private last = -Infinity;

  constructor(
    private readonly intervalMs: number,
    private readonly now: Now = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      this.last = this.now();
    });
    // The next caller waits for this one's turn, never for its answer or its failure.
    this.chain = turn.catch(() => undefined);
    return turn.then(work);
  }
}

/**
 * A budget of `capacity` requests per `windowMs`, for the services that publish one (iTunes about
 * 20 a minute, SongLink 10 a minute without a key). `take` says yes, or when to come back.
 */
export class Budget {
  private stamps: number[] = [];

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: Now = Date.now,
  ) {}

  take(): { ok: true } | { ok: false; retryAt: number } {
    const at = this.now();
    this.stamps = this.stamps.filter((t) => at - t < this.windowMs);
    if (this.stamps.length >= this.capacity) return { ok: false, retryAt: this.stamps[0]! + this.windowMs };
    this.stamps.push(at);
    return { ok: true };
  }
}

/** Two failures in a row rest a provider; each further failure doubles the rest, up to ten minutes. */
export const COOLDOWN_AFTER_FAILURES = 2;
export const COOLDOWN_BASE_MS = 30_000;
export const COOLDOWN_MAX_MS = 10 * 60_000;

interface HealthEntry {
  failures: number;
  coolingUntil: number;
  lastError: string | null;
}

/**
 * Per-provider health with backoff (UX-CAT-001). A failure is a timeout, a dropped connection, a
 * server error or a rate limit; an empty answer is not. A rate limit with a `Retry-After` rests the
 * provider for exactly that long, at once.
 */
export class ProviderHealth {
  private readonly entries = new Map<string, HealthEntry>();

  constructor(private readonly now: Now = Date.now) {}

  private entry(id: string): HealthEntry {
    let e = this.entries.get(id);
    if (!e) {
      e = { failures: 0, coolingUntil: 0, lastError: null };
      this.entries.set(id, e);
    }
    return e;
  }

  /** When the provider may be asked again, or null when it may be asked now. */
  coolingUntil(id: string): number | null {
    const e = this.entries.get(id);
    return e && e.coolingUntil > this.now() ? e.coolingUntil : null;
  }

  lastError(id: string): string | null {
    return this.entries.get(id)?.lastError ?? null;
  }

  success(id: string): void {
    const e = this.entry(id);
    e.failures = 0;
    e.coolingUntil = 0;
    e.lastError = null;
  }

  failure(id: string, error: unknown): void {
    const e = this.entry(id);
    e.failures += 1;
    e.lastError = describeError(error);
    const asked = error instanceof CatalogHttpError && error.kind === 'rate-limited' ? (error.retryAfterMs ?? COOLDOWN_BASE_MS) : null;
    if (asked !== null) {
      e.coolingUntil = this.now() + Math.min(Math.max(asked, 1000), COOLDOWN_MAX_MS);
      return;
    }
    if (e.failures >= COOLDOWN_AFTER_FAILURES) {
      e.coolingUntil = this.now() + Math.min(COOLDOWN_BASE_MS * 2 ** (e.failures - COOLDOWN_AFTER_FAILURES), COOLDOWN_MAX_MS);
    }
  }

  /** Rest the provider until `at` without counting a failure (its own budget ran out). */
  restUntil(id: string, at: number, reason: string): void {
    const e = this.entry(id);
    e.coolingUntil = Math.max(e.coolingUntil, at);
    e.lastError = reason;
  }
}

/** A sentence for the status line; never a stack trace or an internal path. */
export function describeError(error: unknown): string {
  if (error instanceof CatalogHttpError) return error.message.slice(0, 400);
  if (error instanceof Error && error.message) return error.message.replace(/[A-Za-z]:\\[^\s]+|\/(?:home|Users|tmp|var|data)\/[^\s]+/g, '…').slice(0, 400);
  return 'It failed without saying why';
}

export function statusFor(provider: CatalogProviderId, patch: Partial<CatalogSourceStatus>): CatalogSourceStatus {
  return { provider, state: 'pending', count: 0, latencyMs: null, error: null, retryAt: null, ...patch };
}
