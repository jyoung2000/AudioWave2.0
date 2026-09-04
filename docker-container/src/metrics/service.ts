/**
 * Operational metrics for the admin GUI.
 *
 * The registry holds live counters; this service turns them into the shapes the API promises and
 * persists a periodic sample so lifetime totals survive a restart. Nothing here leaves the hub:
 * there is no telemetry endpoint, no phone-home, and IP addresses are already privacy-minimised by
 * the network service before they reach a connection view.
 *
 * `alerts` is deliberately opinionated — an operator should not have to read a counter table to
 * discover that a provider is down or that no backup has ever been taken.
 */
import { statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import type { ProviderHealth } from '@now-playing/contracts';
import { hubIdentity, type HubContext } from '../context.js';
import type { MetricsRepository } from '../db/repositories/metrics.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry, HistogramSummary } from './registry.js';

export interface OverviewData {
  hub: unknown;
  uptimeSeconds: number;
  startedAt: string;
  connections: { active: number; players: number; companions: number; historical: number; reconnects: number; wsErrors: number };
  pairing: { pending: number; attempts: number; failures: number };
  groups: Array<{ groupId: string; name: string; queueLength: number; listeners: number; status: string }>;
  providers: ProviderHealth[];
  jobs: { queued: number; running: number; failed: number; completed: number };
  discord: unknown;
  database: { migrationVersion: number; sizeBytes: number; lastBackupAt: string | null; walMode: boolean };
  storage: { dataDir: string; freeBytes: number | null; totalBytes: number | null };
  alerts: Array<{ level: 'info' | 'warning' | 'error'; message: string }>;
  memoryRssBytes: number;
}

/** How often the in-memory registry is written to the database. */
const SAMPLE_INTERVAL_MS = 60_000;
const SAMPLE_RETENTION_DAYS = 14;

export class MetricsService {
  private lastSampleAt = 0;

  constructor(
    private readonly registry: MetricsRegistry,
    private readonly repo: MetricsRepository,
    private readonly clock: Clock,
    /** Late-bound: the context is not complete when this service is constructed. */
    private readonly ctx: () => HubContext,
  ) {}

  /** Restore lifetime totals so an uptime restart does not read as a usage collapse. */
  restore(): void {
    const latest = this.repo.latest();
    if (latest) this.registry.restoreCounters(latest.counters);
  }

  raw(): { counters: Record<string, number>; histograms: Record<string, HistogramSummary>; generatedAt: string } {
    return { counters: this.registry.snapshotCounters(), histograms: this.registry.snapshotHistograms(), generatedAt: new Date(this.clock.now()).toISOString() };
  }

  async overview(): Promise<OverviewData> {
    const ctx = this.ctx();
    const now = this.clock.now();
    const connections = ctx.realtime.counts();
    const providers = await ctx.providers.healthAll();
    const groups = ctx.groups.listVisible({ id: 'admin', kind: 'admin', displayName: 'Administrator', isHubAdmin: true }).map((g) => ({
      groupId: g.group.id,
      name: g.group.name,
      queueLength: g.queue.items.length,
      listeners: ctx.groups.listenerCount(g.group.id),
      status: g.playback.status,
    }));
    const downloadCounts = ctx.downloads.counts();
    const transferCounts = ctx.transfers.counts();
    const jobs = {
      queued: downloadCounts.queued + transferCounts.queued,
      running: downloadCounts.running + transferCounts.running,
      failed: downloadCounts.failed + transferCounts.failed,
      completed: downloadCounts.completed + transferCounts.completed,
    };
    const storage = await this.storage(ctx.config.dataDir);
    const database = {
      migrationVersion: ctx.lifecycle.migrationVersion,
      sizeBytes: fileSize(ctx.dbFile),
      lastBackupAt: ctx.backup.lastBackupAt(),
      walMode: true,
    };
    const overview: OverviewData = {
      hub: hubIdentity(ctx),
      uptimeSeconds: Math.max(0, Math.round((now - ctx.startedAt) / 1000)),
      startedAt: new Date(ctx.startedAt).toISOString(),
      connections,
      pairing: ctx.pairing.counts(),
      groups,
      providers,
      jobs,
      discord: ctx.discord.status(),
      database,
      storage,
      alerts: this.alerts({ providers, jobs, storage, database, connections }),
      memoryRssBytes: process.memoryUsage().rss,
    };
    return overview;
  }

  private alerts(input: {
    providers: ProviderHealth[];
    jobs: { queued: number; running: number; failed: number; completed: number };
    storage: { freeBytes: number | null; totalBytes: number | null };
    database: { lastBackupAt: string | null };
    connections: { wsErrors: number };
  }): Array<{ level: 'info' | 'warning' | 'error'; message: string }> {
    const ctx = this.ctx();
    const out: Array<{ level: 'info' | 'warning' | 'error'; message: string }> = [];

    if (!ctx.auth.setupComplete()) out.push({ level: 'error', message: 'Setup is not complete: the default password is still in place and remote features stay disabled until it is changed.' });

    for (const p of input.providers) {
      if (p.status === 'down') out.push({ level: 'error', message: `${p.provider} is not responding${p.lastError ? `: ${p.lastError}` : ''}.` });
      else if (p.status === 'degraded') out.push({ level: 'warning', message: `${p.provider} is degraded${p.lastError ? `: ${p.lastError}` : ''}.` });
      if (p.quota && p.quota.used / p.quota.budget >= 0.8) {
        out.push({ level: 'warning', message: `${p.provider} has used ${Math.round((p.quota.used / p.quota.budget) * 100)}% of its daily ${p.quota.unit} budget${p.quota.resetsAt ? `; it resets at ${p.quota.resetsAt}` : ''}.` });
      }
    }

    if (input.jobs.failed > 0) out.push({ level: 'warning', message: `${input.jobs.failed} job${input.jobs.failed === 1 ? '' : 's'} failed. Open Downloads to see why.` });

    if (input.storage.freeBytes !== null && input.storage.totalBytes !== null && input.storage.totalBytes > 0) {
      const freeRatio = input.storage.freeBytes / input.storage.totalBytes;
      if (freeRatio < 0.05) out.push({ level: 'error', message: `The data volume is ${Math.round((1 - freeRatio) * 100)}% full. Downloads and backups will start failing.` });
      else if (freeRatio < 0.15) out.push({ level: 'warning', message: `The data volume is ${Math.round((1 - freeRatio) * 100)}% full.` });
    }

    if (!input.database.lastBackupAt) out.push({ level: 'info', message: 'No backup has been taken yet. Admin → Backup writes one into the data volume.' });

    if (input.connections.wsErrors > 0 && input.connections.wsErrors > this.registry.counter('ws.connections') * 0.1) {
      out.push({ level: 'warning', message: `${input.connections.wsErrors} realtime connections have errored. Check Diagnostics → Logs.` });
    }

    const network = ctx.network.current;
    if (network.bindMode === 'remote' && !network.publicEndpoint) {
      out.push({ level: 'warning', message: 'Remote bind mode is on but no public endpoint is configured, so pairing links and share links will not be reachable.' });
    }
    return out;
  }

  private async storage(dataDir: string): Promise<{ dataDir: string; freeBytes: number | null; totalBytes: number | null }> {
    try {
      const fs = await statfs(dataDir);
      return { dataDir, freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize) };
    } catch {
      // statfs is unavailable on some platforms and inside some containers; report unknown rather
      // than guess a number an operator might act on.
      return { dataDir, freeBytes: null, totalBytes: null };
    }
  }

  connections(): { active: unknown[]; recent: unknown[]; counters: Record<string, number> } {
    const ctx = this.ctx();
    const counters: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.registry.snapshotCounters())) if (k.startsWith('ws.') || k.startsWith('pairing.') || k.startsWith('sync.')) counters[k] = v;
    return { active: ctx.realtime.activeConnections(), recent: ctx.realtime.recentConnections(), counters };
  }

  /** Called from the scheduler; writes at most one sample a minute regardless of tick rate. */
  sample(force = false): boolean {
    const now = this.clock.now();
    if (!force && now - this.lastSampleAt < SAMPLE_INTERVAL_MS) return false;
    this.lastSampleAt = now;
    this.repo.insertSample(new Date(now).toISOString(), this.registry.snapshotCounters(), this.registry.snapshotHistograms());
    return true;
  }

  maintenance(): number {
    return this.repo.purge(new Date(this.clock.now() - SAMPLE_RETENTION_DAYS * 86_400_000).toISOString());
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
