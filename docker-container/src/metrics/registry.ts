export interface HistogramSummary {
  count: number;
  sum: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

const MAX_SAMPLES = 2000;

/** In-memory counters and reservoir histograms; persisted periodically by the metrics service. */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    const arr = this.histograms.get(name) ?? [];
    if (arr.length >= MAX_SAMPLES) arr.splice(0, Math.floor(MAX_SAMPLES / 4));
    arr.push(value);
    this.histograms.set(name, arr);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshotCounters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of [...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
    for (const [k, v] of [...this.gauges.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
    return out;
  }

  snapshotHistograms(): Record<string, HistogramSummary> {
    const out: Record<string, HistogramSummary> = {};
    for (const [k, values] of [...this.histograms.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = summarize(values);
    return out;
  }

  /** Restore counters from the last persisted sample so restarts do not zero lifetime totals. */
  restoreCounters(saved: Record<string, number>): void {
    for (const [k, v] of Object.entries(saved)) if (k.startsWith('total.')) this.counters.set(k, v);
  }
}

export function summarize(values: readonly number[]): HistogramSummary {
  if (!values.length) return { count: 0, sum: 0, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { count: sorted.length, sum: sorted.reduce((a, b) => a + b, 0), p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: sorted[sorted.length - 1]! };
}
