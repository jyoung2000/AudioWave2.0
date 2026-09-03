/** Clock-offset estimation (NTP-style) and drift-correction policy for group playback. */

export interface ClockSample {
  /** client monotonic time when the ping was sent (ms) */
  t0: number;
  /** server receive time (unix ms) */
  t1: number;
  /** server send time (unix ms) */
  t2: number;
  /** client monotonic time when the pong arrived (ms) */
  t3: number;
}

export interface ClockEstimate {
  /** serverTime ≈ clientMonotonic + offsetMs */
  offsetMs: number;
  rttMs: number;
  samples: number;
  /** Half-RTT of the best sample; a proxy for uncertainty. */
  uncertaintyMs: number;
}

export function sampleOffset(s: ClockSample): { offsetMs: number; rttMs: number } {
  const rttMs = s.t3 - s.t0 - (s.t2 - s.t1);
  const offsetMs = (s.t1 - s.t0 + (s.t2 - s.t3)) / 2;
  return { offsetMs, rttMs: Math.max(0, rttMs) };
}

/** Use the median offset of the lowest-RTT half of samples: robust to jitter and asymmetric spikes. */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate | null {
  if (!samples.length) return null;
  const computed = samples.map(sampleOffset).sort((a, b) => a.rttMs - b.rttMs);
  const best = computed.slice(0, Math.max(1, Math.ceil(computed.length / 2)));
  const offsets = best.map((c) => c.offsetMs).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const offsetMs = offsets.length % 2 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
  return { offsetMs, rttMs: best[0]!.rttMs, samples: samples.length, uncertaintyMs: best[0]!.rttMs / 2 };
}

/** Expected playback position (ms) on the hub timeline for a track that started at `startAtServerMs`. */
export function expectedPosition(startAtServerMs: number, serverNowMs: number, paused: { at: number | null; positionMs: number } | null, dspLatencyMs = 0): number {
  if (paused && paused.at !== null) return paused.positionMs;
  return Math.max(0, serverNowMs - startAtServerMs - dspLatencyMs);
}

export type DriftAction = { kind: 'none' } | { kind: 'nudge'; playbackRate: number; forMs: number } | { kind: 'seek'; toPositionMs: number };

/**
 * Small drift is corrected gently by adjusting playbackRate for a bounded period; larger drift hard-seeks.
 * Thresholds come from group settings (defaults: soft 60 ms, hard 400 ms).
 */
export function decideDriftCorrection(driftMs: number, expectedMs: number, thresholds: { softMs: number; hardMs: number }): DriftAction {
  const abs = Math.abs(driftMs);
  if (abs < thresholds.softMs) return { kind: 'none' };
  if (abs >= thresholds.hardMs) return { kind: 'seek', toPositionMs: expectedMs };
  // correct within ~2 s using a rate of at most ±3 %
  const rate = driftMs > 0 ? 0.97 : 1.03;
  const forMs = Math.min(4000, Math.ceil(abs / 0.03));
  return { kind: 'nudge', playbackRate: rate, forMs };
}

/** Reconnect delay with full jitter, capped. attempt starts at 0. */
export function reconnectDelayMs(attempt: number, baseMs = 500, maxMs = 30_000, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return Math.round(exp * (0.5 + random() * 0.5));
}
