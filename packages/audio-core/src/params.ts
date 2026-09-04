/**
 * AudioParam automation helpers. The engine never writes `param.value` while running; every
 * change goes through the automation timeline so the audio thread interpolates it.
 */
import type { AudioParamLike } from './types.js';

export const DEFAULT_RAMP_MS = 40;
export const BYPASS_CROSSFADE_MS = 30;
/** Ramps shorter than this are clamped up (or rejected in strict mode). */
export const MIN_RAMP_MS = 1;
export const MAX_RAMP_MS = 10_000;

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Power-weighted mean of dB values (what a level meter would average), in dB. */
export function powerMeanDb(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += 10 ** (v / 10);
  return 10 * Math.log10(sum / values.length);
}

/**
 * Anchor the param at its current value and ramp linearly to `target` over `rampMs`.
 * `cancelScheduledValues` first so a ramp in flight is replaced, not queued behind.
 */
export function rampParam(param: AudioParamLike, target: number, now: number, rampMs: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (rampMs > 0) param.linearRampToValueAtTime(target, now + rampMs / 1000);
  else param.setValueAtTime(target, now);
}

/**
 * Exponential approach for frequency / Q: `setTargetAtTime` with a time constant of a third of
 * the ramp (≈95 % settled at `rampMs`), which keeps filter coefficients moving smoothly.
 */
export function glideParam(param: AudioParamLike, target: number, now: number, rampMs: number): void {
  param.cancelScheduledValues(now);
  if (rampMs > 0) param.setTargetAtTime(target, now, Math.max(0.0005, rampMs / 3000));
  else param.setValueAtTime(target, now);
}

/** Initial value for a freshly created node (nothing is flowing yet, so a scheduled set is safe). */
export function initParam(param: AudioParamLike, value: number, now: number): void {
  param.setValueAtTime(value, now);
}
