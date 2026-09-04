/**
 * Background work: one timer, many named tasks.
 *
 * Two kinds of work live here.
 *
 * *Periodic tasks* are maintenance the hub owes itself — expiring pairing sessions, compacting
 * tombstones, sampling metrics, retrying downloads, refreshing tokens before they expire. Each runs
 * on its own interval, is guarded against overlapping with itself, and can never take the process
 * down: a task that throws is logged and its next run is scheduled as usual.
 *
 * *Discovery jobs* are the queued, per-user work of the recommendation engine (spec §22): profile
 * refreshes, platform library syncs, seed discovery, token refresh and new-release checks. They are
 * persisted, claimed one at a time, retried with exponential backoff and priority-ordered P0→P4, so
 * a user-facing token refresh never queues behind a nightly catalogue crawl.
 *
 * Nothing here runs when `disableBackgroundJobs` is set: tests drive time explicitly with
 * `runDue()` and `runJobOnce()` so their results do not depend on wall-clock timing.
 */
import type { DiscoveryJob } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { Logger } from 'pino';
import type { HubContext } from '../context.js';
import type { Clock } from '../deps.js';
import { backoffMs } from '../util.js';

export interface PeriodicTask {
  name: string;
  intervalMs: number;
  /** Run once at startup rather than waiting a whole interval. */
  runAtStart?: boolean;
  /** Return values are ignored; tasks report through metrics and the log. */
  run: () => unknown;
}

interface TaskState {
  task: PeriodicTask;
  nextRunAt: number;
  running: boolean;
  runs: number;
  failures: number;
  lastError: string | null;
  lastRunAt: number | null;
}

/** The scheduler wakes this often and runs whatever is due. */
const TICK_MS = 5_000;
const JOB_MAX_ATTEMPTS = 5;
const JOB_BASE_BACKOFF_MS = 30_000;
const JOB_MAX_BACKOFF_MS = 30 * 60_000;

export type JobHandler = (job: DiscoveryJob, ctx: HubContext) => Promise<void> | void;

export class JobScheduler {
  private readonly tasks: TaskState[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private jobRunning = false;
  private readonly handlers = new Map<DiscoveryJob['kind'], JobHandler>();

  constructor(
    private readonly ctx: () => HubContext,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly enabled: boolean,
  ) {}

  register(task: PeriodicTask): void {
    this.tasks.push({ task, nextRunAt: this.clock.now() + (task.runAtStart ? 0 : task.intervalMs), running: false, runs: 0, failures: 0, lastError: null, lastRunAt: null });
  }

  handle(kind: DiscoveryJob['kind'], handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Install the standard task set. Called once from `buildApp`. */
  registerDefaults(): void {
    const ctx = (): HubContext => this.ctx();
    this.register({ name: 'pairing.expire', intervalMs: 30_000, run: () => ctx().pairing.maintenance() });
    this.register({ name: 'auth.purgeSessions', intervalMs: 5 * 60_000, run: () => ctx().auth.purgeExpired() });
    this.register({ name: 'groups.timers', intervalMs: 1_000, run: () => ctx().groups.runDueTimers() });
    this.register({ name: 'metrics.sample', intervalMs: 60_000, run: () => ctx().metricsService.sample() });
    this.register({ name: 'metrics.purge', intervalMs: 6 * 60 * 60_000, run: () => ctx().metricsService.maintenance() });
    this.register({ name: 'downloads.maintenance', intervalMs: 30_000, run: () => ctx().downloads.maintenance() });
    this.register({ name: 'transfers.reconcile', intervalMs: 60_000, run: () => ctx().transfers.reconcile() });
    this.register({ name: 'files.maintenance', intervalMs: 60 * 60_000, run: () => ctx().files.maintenance() });
    this.register({ name: 'sync.compact', intervalMs: 60 * 60_000, run: () => ctx().sync.maintenance() });
    this.register({ name: 'shares.purge', intervalMs: 60 * 60_000, run: () => ctx().shares.maintenance() });
    this.register({ name: 'library.maintenance', intervalMs: 60 * 60_000, run: () => ctx().library.maintenance() });
    this.register({ name: 'providers.cachePurge', intervalMs: 30 * 60_000, run: () => ctx().search.purgeCache() });
    this.register({ name: 'accounts.maintenance', intervalMs: 10 * 60_000, run: () => ctx().accounts.maintenance() });
    this.register({ name: 'discovery.cachePurge', intervalMs: 60 * 60_000, run: () => ctx().platformSync.maintenance() });
    this.register({ name: 'audit.purge', intervalMs: 12 * 60 * 60_000, run: () => ctx().audit.maintenance() });
    this.register({ name: 'releases.refresh', intervalMs: 6 * 60 * 60_000, runAtStart: false, run: () => ctx().releases.refresh() });
    this.register({ name: 'backup.daily', intervalMs: 24 * 60 * 60_000, run: () => ctx().backup.create(null, null) });
    // Token refresh is scheduled as a *job* rather than done inline, so it is retried and
    // priority-ordered like any other per-user work.
    this.register({ name: 'accounts.scheduleRefresh', intervalMs: 5 * 60_000, run: () => this.scheduleTokenRefreshes() });
    this.register({ name: 'discovery.profiles', intervalMs: 60 * 60_000, run: () => this.scheduleProfileRefreshes() });
    this.register({ name: 'jobs.recover', intervalMs: 10 * 60_000, run: () => ctx().repos.canonical.recoverRunningJobs(this.nowIso()) });
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.ctx().repos.canonical.recoverRunningJobs(this.nowIso());
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // Never hold the process open for a background timer.
    this.timer.unref?.();
    this.log.info({ tasks: this.tasks.length }, 'background scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runDue();
      await this.runJobOnce();
    } finally {
      this.ticking = false;
    }
  }

  /** Run every periodic task that is due. Exposed so tests can drive it without a timer. */
  async runDue(): Promise<string[]> {
    const now = this.clock.now();
    const ran: string[] = [];
    for (const state of this.tasks) {
      if (state.running || state.nextRunAt > now) continue;
      state.running = true;
      try {
        await state.task.run();
        state.lastError = null;
      } catch (err) {
        state.failures += 1;
        state.lastError = err instanceof Error ? err.message : String(err);
        // A failing maintenance task must never stop the others or the process.
        this.log.warn({ task: state.task.name, err: state.lastError }, 'background task failed');
        this.ctx().metrics.increment(`jobs.task_failed.${state.task.name}`);
      } finally {
        state.running = false;
        state.runs += 1;
        state.lastRunAt = this.clock.now();
        state.nextRunAt = this.clock.now() + state.task.intervalMs;
        ran.push(state.task.name);
      }
    }
    return ran;
  }

  /* ------------------------------------------------------------ discovery jobs */

  enqueue(input: { userId: string; kind: DiscoveryJob['kind']; priority?: DiscoveryJob['priority']; payload?: Record<string, unknown>; delayMs?: number }): DiscoveryJob {
    const now = this.clock.now();
    const job: DiscoveryJob = {
      id: uuidv7(now),
      state: 'queued',
      userId: input.userId,
      kind: input.kind,
      priority: input.priority ?? 'P3',
      payload: input.payload ?? {},
      attempts: 0,
      nextRunAt: new Date(now + (input.delayMs ?? 0)).toISOString(),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      error: null,
    };
    this.ctx().repos.canonical.enqueueJob(job);
    this.ctx().metrics.increment(`jobs.enqueued.${input.kind}`);
    return job;
  }

  /**
   * Claim and run at most one queued job. One at a time is deliberate: the hub shares a single
   * outbound rate-limit budget per provider, so running jobs in parallel would only make them
   * queue inside the rate limiter instead.
   */
  async runJobOnce(): Promise<DiscoveryJob | null> {
    if (this.jobRunning) return null;
    const ctx = this.ctx();
    const job = ctx.repos.canonical.claimDueJob(this.nowIso());
    if (!job) return null;
    this.jobRunning = true;
    const started = this.clock.now();
    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) {
        ctx.repos.canonical.finishJob(job.id, 'failed', this.nowIso(), `No handler is registered for ${job.kind} jobs`);
        return job;
      }
      await handler(job, ctx);
      ctx.repos.canonical.finishJob(job.id, 'completed', this.nowIso(), null);
      ctx.metrics.increment(`jobs.completed.${job.kind}`);
      ctx.metrics.observe(`jobs.duration_ms.${job.kind}`, this.clock.now() - started);
      return { ...job, state: 'completed' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= JOB_MAX_ATTEMPTS) {
        ctx.repos.canonical.finishJob(job.id, 'failed', this.nowIso(), message.slice(0, 500));
        ctx.metrics.increment(`jobs.failed.${job.kind}`);
        this.log.warn({ job: job.id, kind: job.kind, err: message }, 'discovery job gave up');
        return { ...job, state: 'failed', error: message };
      }
      const retryAt = new Date(this.clock.now() + backoffMs(job.attempts, JOB_BASE_BACKOFF_MS, JOB_MAX_BACKOFF_MS)).toISOString();
      ctx.repos.canonical.finishJob(job.id, 'queued', this.nowIso(), message.slice(0, 500), retryAt);
      ctx.metrics.increment(`jobs.retried.${job.kind}`);
      return { ...job, state: 'queued', error: message };
    } finally {
      this.jobRunning = false;
    }
  }

  /** Drain the queue, bounded, for tests and for the admin "run now" action. */
  async drain(max = 50): Promise<number> {
    let n = 0;
    for (let i = 0; i < max; i += 1) {
      const job = await this.runJobOnce();
      if (!job) break;
      n += 1;
    }
    return n;
  }

  private scheduleTokenRefreshes(): void {
    const ctx = this.ctx();
    const users = ctx.repos.devices.listUsers().map((u) => u.id);
    for (const due of ctx.accounts.dueForRefresh(users)) {
      // P0: a stale token breaks a user-facing request, so it outranks every other job.
      this.enqueue({ userId: due.ownerUserId, kind: 'token-refresh', priority: 'P0', payload: { provider: due.provider } });
    }
  }

  private scheduleProfileRefreshes(): void {
    const ctx = this.ctx();
    for (const userId of ctx.repos.canonical.usersWithEvents()) {
      this.enqueue({ userId, kind: 'profile-refresh', priority: 'P3' });
    }
  }

  /** Install the standard job handlers. */
  registerDefaultHandlers(): void {
    this.handle('token-refresh', async (job, ctx) => {
      const provider = typeof job.payload['provider'] === 'string' ? job.payload['provider'] : null;
      if (!provider) return;
      // `authorize` refreshes as a side effect and records the new expiry.
      await ctx.accounts.authorize(provider, job.userId);
    });

    this.handle('profile-refresh', (job, ctx) => {
      ctx.recommendations.rebuildProfile(job.userId);
    });

    this.handle('sync-library', async (job, ctx) => {
      const provider = typeof job.payload['provider'] === 'string' ? job.payload['provider'] : null;
      if (!provider) return;
      await ctx.platformSync.syncLibrary(job.userId, provider);
    });

    this.handle('discover-seeds', async (job, ctx) => {
      await ctx.platformSync.warmDiscoveryCache(job.userId);
    });

    this.handle('new-releases', async (job, ctx) => {
      await ctx.platformSync.refreshNewReleases(job.userId);
    });
  }

  /** Task health for the admin GUI's diagnostics panel. */
  status(): Array<{ name: string; intervalMs: number; runs: number; failures: number; lastError: string | null; lastRunAt: string | null; nextRunAt: string }> {
    return this.tasks.map((s) => ({
      name: s.task.name,
      intervalMs: s.task.intervalMs,
      runs: s.runs,
      failures: s.failures,
      lastError: s.lastError,
      lastRunAt: s.lastRunAt === null ? null : new Date(s.lastRunAt).toISOString(),
      nextRunAt: new Date(s.nextRunAt).toISOString(),
    }));
  }

  jobCounts(): Record<string, number> {
    return this.ctx().repos.canonical.jobCounts();
  }
}
