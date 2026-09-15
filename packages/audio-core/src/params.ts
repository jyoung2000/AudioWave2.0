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

/** Straight segments used to draw the equal-power crossfade curves. */
export const CROSSFADE_SEGMENTS = 8;

/**
 * Equal-power fade for a crossfade: the outgoing leg follows a quarter cosine and the incoming leg
 * a quarter sine, so the summed loudness stays level through the overlap instead of dipping in the
 * middle the way two linear ramps do. Only linear ramps are available on every param we accept, so
 * each curve is drawn as eight straight segments, which stays within 0.6 % of the ideal.
 *
 * The fade starts from the param's current value, so a fade-out that interrupts a fade-in begins
 * wherever that fade-in had reached rather than jumping to full level first.
 */
export function fadeParam(param: AudioParamLike, direction: 'in' | 'out', now: number, durationMs: number, options: { peak?: number; from?: number } = {}): void {
  // Read the level before cancelling: once the pending ramp is gone the param reports the last
  // scheduled point instead of where the ramp had actually reached.
  const current = param.value;
  param.cancelScheduledValues(now);
  const peak = options.peak ?? 1;
  // An incoming source starts from silence unless told otherwise; an outgoing one leaves from wherever it is.
  const start = options.from ?? (direction === 'in' ? 0 : current);
  const end = direction === 'in' ? peak : 0;
  if (durationMs <= 0) {
    param.setValueAtTime(end, now);
    return;
  }
  param.setValueAtTime(start, now);
  const seconds = durationMs / 1000;
  for (let i = 1; i <= CROSSFADE_SEGMENTS; i += 1) {
    const x = i / CROSSFADE_SEGMENTS;
    const shape = direction === 'in' ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
    const value = direction === 'in' ? start + (end - start) * shape : start * shape;
    param.linearRampToValueAtTime(i === CROSSFADE_SEGMENTS ? end : value, now + seconds * x);
  }
}
