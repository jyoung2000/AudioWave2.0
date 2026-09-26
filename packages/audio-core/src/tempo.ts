/**
 * A tempo from audio, the plain way: an onset strength curve (how much louder each frame is than
 * the last, per band), then autocorrelation over the lags that correspond to 40–200 BPM, then the
 * strongest lag. No model, no network, a few dozen lines of arithmetic that run the same in Node,
 * in a browser and in the companion. Good to about a beat per minute on anything with a beat;
 * honest (null) on silence and on clips too short to hold eight bars.
 */
const FRAME = 1024;
const HOP = 512;
const BANDS = 8;
const MIN_BPM = 40; // search below the fold window so a slow pulse is found, then folded up
const MAX_BPM = 200;
const MIN_SECONDS = 8;
const FOLD_LOW = 70;
const FOLD_HIGH = 180;
const MIN_CONFIDENCE = 1.2;

export interface TempoEstimate {
  bpm: number;
  /** Peak of the autocorrelation over its mean in the search band; 1 is noise, 2+ is a clear beat. */
  confidence: number;
}

export function estimateTempo(samples: Float32Array, sampleRate: number): TempoEstimate | null {
  if (samples.length < sampleRate * MIN_SECONDS) return null;
  const frames = Math.floor((samples.length - FRAME) / HOP);
  if (frames < 32) return null;

  // Onset strength: the positive change in energy, summed across coarse bands (a cheap spectral flux).
  const prev = new Float32Array(BANDS);
  const onset = new Float32Array(frames);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let flux = 0;
    for (let b = 0; b < BANDS; b++) {
      const lo = Math.floor((b / BANDS) * FRAME);
      const hi = Math.floor(((b + 1) / BANDS) * FRAME);
      let e = 0;
      for (let i = lo; i < hi; i++) {
        const s = samples[off + i]!;
        e += s * s;
      }
      const cur = Math.sqrt(e / (hi - lo));
      const d = cur - prev[b]!;
      if (d > 0) flux += d;
      prev[b] = cur;
    }
    onset[f] = flux;
    total += flux;
  }
  if (total <= 1e-6) return null;
  const mean = total / frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f]! - mean);

  // Autocorrelation over the lag window that corresponds to the tempo range.
  const fps = sampleRate / HOP;
  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * fps));
  const maxLag = Math.min(frames - 2, Math.ceil((60 / MIN_BPM) * fps));
  const ac = new Float32Array(maxLag + 2);
  let bestLag = -1;
  let best = 0;
  let sum = 0;
  let n = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f]! * onset[f - lag]!;
    const v = s / (frames - lag);
    ac[lag] = v;
    sum += v;
    n++;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best <= 0 || n === 0) return null;

  // Parabolic interpolation around the peak for sub-lag precision.
  const l = bestLag > minLag ? ac[bestLag - 1]! : best;
  const r = bestLag < maxLag ? ac[bestLag + 1]! : best;
  const denom = l - 2 * best + r;
  const shift = denom !== 0 ? (0.5 * (l - r)) / denom : 0;
  let bpm = 60 / ((bestLag + shift) / fps);
  while (bpm < FOLD_LOW) bpm *= 2;
  while (bpm > FOLD_HIGH) bpm /= 2;

  const confidence = best / (sum / n);
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null;
  return { bpm: Math.round(bpm), confidence: Math.round(confidence * 100) / 100 };
}
