import type { Db } from '../connection.js';

export class MetricsRepository {
  constructor(private readonly db: Db) {}

  insertSample(sampledAt: string, counters: Record<string, number>, histograms: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO metrics_samples (sampled_at, counters, histograms) VALUES (?, ?, ?)').run(sampledAt, JSON.stringify(counters), JSON.stringify(histograms));
  }

  latest(): { sampledAt: string; counters: Record<string, number> } | undefined {
    const r = this.db.prepare<[], { sampled_at: string; counters: string }>('SELECT sampled_at, counters FROM metrics_samples ORDER BY id DESC LIMIT 1').get();
    return r ? { sampledAt: r.sampled_at, counters: JSON.parse(r.counters) as Record<string, number> } : undefined;
  }

  purge(before: string): number {
    return this.db.prepare('DELETE FROM metrics_samples WHERE sampled_at < ?').run(before).changes;
  }

  count(): number {
    return this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM metrics_samples').get()?.n ?? 0;
  }
}
