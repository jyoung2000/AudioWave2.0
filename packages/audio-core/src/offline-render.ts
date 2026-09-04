/**
 * Offline helpers for measuring what the pitch shifter actually does, without a browser.
 * Used by the unit tests (and useful when tuning the grain size) to prove the claims the UI makes:
 * ratio 1 is bit-exact, a semitone up really measures a semitone up, latency is half a grain.
 */
import { PitchShifterCore, defaultGrainSize } from './worklets/pitch-shifter-core.js';

export const DEFAULT_BLOCK_SIZE = 128;

export interface RenderOptions {
  /** Render block size, mirroring the AudioWorklet quantum. Default 128. */
  blockSize?: number;
  /** Grain size in samples; default `defaultGrainSize(sampleRate)`. */
  grainSize?: number;
  bypass?: boolean;
}

/** Render one mono channel through `PitchShifterCore` block by block, exactly as the worklet does. */
export function renderThroughCore(samples: Float32Array, sampleRate: number, ratio: number, options: RenderOptions = {}): Float32Array {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const grainSize = options.grainSize ?? defaultGrainSize(sampleRate);
  const core = new PitchShifterCore(sampleRate, 1, grainSize);
  const out = new Float32Array(samples.length);
  const inBlock = new Float32Array(blockSize);
  const outBlock = new Float32Array(blockSize);
  for (let offset = 0; offset < samples.length; offset += blockSize) {
    const n = Math.min(blockSize, samples.length - offset);
    inBlock.fill(0);
    inBlock.set(samples.subarray(offset, offset + n));
    outBlock.fill(0);
    core.process([inBlock], [outBlock], ratio, options.bypass ?? false);
    out.set(outBlock.subarray(0, n), offset);
  }
  return out;
}

export function makeSine(frequencyHz: number, sampleRate: number, durationSeconds: number, amplitude = 0.5): Float32Array {
  const length = Math.round(sampleRate * durationSeconds);
  const out = new Float32Array(length);
  const step = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let i = 0; i < length; i += 1) out[i] = amplitude * Math.sin(step * i);
  return out;
}

/**
 * Autocorrelation pitch estimate. Normalised so long lags are not favoured, and locked to the
 * fundamental rather than a subharmonic by skipping past the first zero crossing of the
 * correlation before hunting for the peak; parabolic interpolation around the winner keeps the
 * estimate accurate to well under 1 % for clean tones.
 */
export function estimateFundamentalHz(samples: Float32Array, sampleRate: number, options: { minHz?: number; maxHz?: number } = {}): number | null {
  const minHz = options.minHz ?? 50;
  const maxHz = options.maxHz ?? Math.min(4000, sampleRate / 2 - 1);
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2));
  if (maxLag <= minLag) return null;

  let mean = 0;
  for (const s of samples) mean += s;
  mean /= samples.length || 1;
  const centred = Float32Array.from(samples, (s) => s - mean);

  let energy = 0;
  for (const s of centred) energy += s * s;
  if (energy < 1e-9) return null;

  const window = centred.length - maxLag;
  if (window <= 1) return null;

  /** Normalised cross-correlation of the first `window` samples against the same window at `lag`. */
  const correlate = (lag: number): number => {
    let sum = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i < window; i += 1) {
      const a = centred[i]!;
      const b = centred[i + lag]!;
      sum += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denominator = Math.sqrt(energyA * energyB);
    return denominator > 0 ? sum / denominator : 0;
  };

  // Walk past the initial descent so the first strong peak is the fundamental, not lag 0's tail.
  let lag = minLag;
  while (lag < maxLag && correlate(lag) > 0) lag += 1;
  if (lag >= maxLag) lag = minLag;

  let bestLag = -1;
  let bestValue = -Infinity;
  for (; lag <= maxLag; lag += 1) {
    const value = correlate(lag);
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || bestValue <= 0) return null;

  const prev = correlate(Math.max(1, bestLag - 1));
  const next = correlate(Math.min(maxLag, bestLag + 1));
  const denominator = prev - 2 * bestValue + next;
  const shift = denominator === 0 ? 0 : (0.5 * (prev - next)) / denominator;
  return sampleRate / (bestLag + shift);
}

/** RMS of a slice, used to check the crossfade never mutes the signal. */
export function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  const n = Math.max(0, to - from);
  for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!;
  return n ? Math.sqrt(sum / n) : 0;
}

/** Largest absolute difference between two signals (0 proves a bit-exact passthrough). */
export function maxAbsDifference(a: Float32Array, b: Float32Array): number {
  let max = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}
