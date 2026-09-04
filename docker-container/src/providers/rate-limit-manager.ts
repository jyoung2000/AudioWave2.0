import { DomainError } from '@now-playing/domain';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import { ProviderHttpError } from './http.js';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface ProviderBudget {
  perMinute: number;
  perDay: number | null;
  concurrency: number;
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before a half-open probe. */
  openMs: number;
  /** Below this fraction of the daily budget, P3/P4 work is shed; below half of it, P2 is shed too. */
  shedBelowFraction: number;
}

export const DEFAULT_BUDGET: ProviderBudget = { perMinute: 60, perDay: null, concurrency: 4, failureThreshold: 5, openMs: 30_000, shedBelowFraction: 0.3 };

interface ProviderState {
  budget: ProviderBudget;
  minuteWindowStart: number;
  usedMinute: number;
  dayWindowStart: number;
  usedDay: number;
  inFlight: number;
  consecutiveFailures: number;
  circuit: 'closed' | 'open' | 'half-open';
  openedAt: number | null;
  pausedUntil: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: number | null;
  queueDepth: Record<Priority, number>;
  shed: Record<Priority, number>;
  waiters: Array<{ priority: Priority; resolve: () => void; reject: (e: Error) => void; enqueuedAt: number }>;
}

const PRIORITY_ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];
const DAY_MS = 24 * 3600 * 1000;
const MAX_QUEUE_WAIT_MS = 20_000;

/**
 * Central budget/priority/circuit manager for every outbound provider call. P0 = interactive user actions,
 * P1 = search, P2 = sync refresh, P3 = background discovery, P4 = speculative prefetch. When a daily budget runs low the
 * lower priorities are shed first; 429 responses pause the provider until Retry-After; repeated failures open a circuit.
 */
export class RateLimitManager {
  private readonly providers = new Map<string, ProviderState>();

  constructor(
    private readonly clock: Clock,
    private readonly metrics: MetricsRegistry,
  ) {}

  configure(provider: string, budget: Partial<ProviderBudget>): void {
    const state = this.state(provider);
    state.budget = { ...state.budget, ...budget };
  }

  private state(provider: string): ProviderState {
    let s = this.providers.get(provider);
    if (!s) {
      const now = this.clock.now();
      s = { budget: { ...DEFAULT_BUDGET }, minuteWindowStart: now, usedMinute: 0, dayWindowStart: now, usedDay: 0, inFlight: 0, consecutiveFailures: 0, circuit: 'closed', openedAt: null, pausedUntil: null, lastError: null, lastLatencyMs: null, lastCheckedAt: null, queueDepth: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }, shed: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 }, waiters: [] };
      this.providers.set(provider, s);
    }
    return s;
  }

  private roll(s: ProviderState): void {
    const now = this.clock.now();
    if (now - s.minuteWindowStart >= 60_000) {
      s.minuteWindowStart = now;
      s.usedMinute = 0;
    }
    if (now - s.dayWindowStart >= DAY_MS) {
      s.dayWindowStart = now;
      s.usedDay = 0;
    }
    if (s.circuit === 'open' && s.openedAt !== null && now - s.openedAt >= s.budget.openMs) s.circuit = 'half-open';
    if (s.pausedUntil !== null && now >= s.pausedUntil) s.pausedUntil = null;
  }

  private shouldShed(s: ProviderState, priority: Priority): boolean {
    if (s.budget.perDay === null) return false;
    const remaining = 1 - s.usedDay / s.budget.perDay;
    if (remaining <= 0) return priority !== 'P0';
    if (remaining < s.budget.shedBelowFraction / 2) return priority === 'P2' || priority === 'P3' || priority === 'P4';
    if (remaining < s.budget.shedBelowFraction) return priority === 'P3' || priority === 'P4';
    return false;
  }

  private canStart(s: ProviderState, priority: Priority): boolean {
    this.roll(s);
    if (s.pausedUntil !== null) return false;
    if (s.circuit === 'open') return false;
    if (s.circuit === 'half-open' && s.inFlight > 0) return false;
    if (s.inFlight >= s.budget.concurrency) return false;
    if (s.usedMinute >= s.budget.perMinute) return false;
    if (s.budget.perDay !== null && s.usedDay >= s.budget.perDay && priority !== 'P0') return false;
    return true;
  }

  /** Acquire a slot (waiting in priority order up to 20 s), run the call, record the outcome. */
  async run<T>(provider: string, priority: Priority, fn: (signal: AbortSignal) => Promise<T>, options: { cost?: number; timeoutMs?: number } = {}): Promise<T> {
    const s = this.state(provider);
    this.roll(s);
    if (this.shouldShed(s, priority)) {
      s.shed[priority] += 1;
      this.metrics.increment(`providers.${provider}.shed`);
      throw new DomainError('rate-limited', `${provider} daily budget is low; ${priority} work deferred`, { retryAfterSeconds: 300 });
    }
    if (s.circuit === 'open') throw new DomainError('unavailable', `${provider} circuit is open after repeated failures`, { retryAfterSeconds: Math.ceil(s.budget.openMs / 1000) });
    if (s.pausedUntil !== null) throw new DomainError('rate-limited', `${provider} asked us to slow down`, { retryAfterSeconds: Math.ceil((s.pausedUntil - this.clock.now()) / 1000) });
    await this.acquire(s, priority, provider);
    const cost = options.cost ?? 1;
    s.inFlight += 1;
    s.usedMinute += cost;
    s.usedDay += cost;
    const started = this.clock.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? 15_000);
    try {
      const result = await fn(controller.signal);
      s.consecutiveFailures = 0;
      s.circuit = 'closed';
      s.lastLatencyMs = this.clock.now() - started;
      s.lastCheckedAt = this.clock.now();
      s.lastError = null;
      this.metrics.observe(`providers.${provider}.latency_ms`, s.lastLatencyMs);
      this.metrics.increment(`providers.${provider}.ok`);
      return result;
    } catch (err) {
      s.lastCheckedAt = this.clock.now();
      s.lastError = err instanceof Error ? err.message : String(err);
      this.metrics.increment(`providers.${provider}.errors`);
      if (err instanceof ProviderHttpError && err.status === 429) {
        s.pausedUntil = this.clock.now() + (err.retryAfterSeconds ?? 30) * 1000;
        this.metrics.increment(`providers.${provider}.throttled`);
      } else if (!(err instanceof DomainError && (err.code === 'validation' || err.code === 'not-found'))) {
        s.consecutiveFailures += 1;
        if (s.consecutiveFailures >= s.budget.failureThreshold || s.circuit === 'half-open') {
          s.circuit = 'open';
          s.openedAt = this.clock.now();
          this.metrics.increment(`providers.${provider}.circuit_opened`);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
      s.inFlight -= 1;
      this.drain(s, provider);
    }
  }

  private acquire(s: ProviderState, priority: Priority, provider: string): Promise<void> {
    if (this.canStart(s, priority) && s.waiters.length === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = { priority, resolve, reject, enqueuedAt: this.clock.now() };
      s.waiters.push(waiter);
      s.queueDepth[priority] += 1;
      const timer = setTimeout(() => {
        const idx = s.waiters.indexOf(waiter);
        if (idx >= 0) {
          s.waiters.splice(idx, 1);
          s.queueDepth[priority] -= 1;
          reject(new DomainError('rate-limited', `${provider} is busy; try again shortly`, { retryAfterSeconds: 5 }));
        }
      }, MAX_QUEUE_WAIT_MS);
      timer.unref?.();
      const original = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timer);
        original();
      };
      this.drain(s, provider);
    });
  }

  private drain(s: ProviderState, _provider: string): void {
    s.waiters.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) || a.enqueuedAt - b.enqueuedAt);
    while (s.waiters.length) {
      const next = s.waiters[0]!;
      if (!this.canStart(s, next.priority)) break;
      s.waiters.shift();
      s.queueDepth[next.priority] -= 1;
      next.resolve();
    }
    if (s.waiters.length && !this.canStart(s, s.waiters[0]!.priority)) {
      const retry = setTimeout(() => this.drain(s, _provider), 250);
      retry.unref?.();
    }
  }

  usage(provider: string): { budget: { perMinute: number; perDay: number | null; usedMinute: number; usedDay: number; shedding: string[] }; queueDepth: Record<string, number>; concurrency: { limit: number; inFlight: number }; circuit: 'closed' | 'open' | 'half-open'; lastError: string | null; latencyMs: number | null; pausedUntil: number | null; checkedAt: number | null } {
    const s = this.state(provider);
    this.roll(s);
    const shedding = PRIORITY_ORDER.filter((p) => this.shouldShed(s, p));
    return { budget: { perMinute: s.budget.perMinute, perDay: s.budget.perDay, usedMinute: s.usedMinute, usedDay: s.usedDay, shedding }, queueDepth: { ...s.queueDepth }, concurrency: { limit: s.budget.concurrency, inFlight: s.inFlight }, circuit: s.circuit, lastError: s.lastError, latencyMs: s.lastLatencyMs, pausedUntil: s.pausedUntil, checkedAt: s.lastCheckedAt };
  }

  reset(provider: string): void {
    this.providers.delete(provider);
  }
}
