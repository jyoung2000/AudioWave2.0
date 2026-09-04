/**
 * Preset → filter-parameter mapping and validation.
 *
 * Graphic presets always become the ten fixed peaking bands (32 Hz … 16 kHz, Q 1.1); parametric
 * presets keep their own type/frequency/gain/Q for up to 32 bands. Disabled bands are made
 * transparent (peaking, 0 dB) rather than removed so node topology never changes for a toggle.
 */
import { EQ_BAND_FREQUENCIES_HZ, EqPreset as EqPresetSchema, type EqBand, type EqPreset } from '@now-playing/contracts';
import { clampGain, eqCurve, requiredHeadroomDb } from '@now-playing/domain';
import { powerMeanDb } from './params.js';

export const GRAPHIC_BAND_Q = 1.1;
export const MAX_BANDS = 32;
export const MIN_FREQUENCY_HZ = 10;

/** Per-node filter settings; the same shape as `EqBand`, fully resolved. */
export type BandParams = EqBand;

export type PresetValidation = { ok: true; preset: EqPreset } | { ok: false; errors: string[] };

/** Validate against the canonical contracts schema (also normalises defaults such as `q`). */
export function validatePreset(input: unknown): PresetValidation {
  const parsed = EqPresetSchema.safeParse(input);
  if (parsed.success) return { ok: true, preset: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

/** Highest centre frequency a BiquadFilter can be asked for at this sample rate. */
export function maxFilterFrequencyHz(sampleRate: number): number {
  return Math.max(MIN_FREQUENCY_HZ, sampleRate / 2 - 1);
}

function neutralBand(frequencyHz: number, q: number): BandParams {
  return { frequencyHz, gainDb: 0, q, type: 'peaking', enabled: false };
}

/** Resolve a preset into concrete per-band filter parameters for `sampleRate`. */
export function presetToBandParams(preset: EqPreset, sampleRate = 48000): BandParams[] {
  const fMax = maxFilterFrequencyHz(sampleRate);
  const clampF = (f: number): number => Math.min(fMax, Math.max(MIN_FREQUENCY_HZ, f));
  if (preset.mode === 'graphic') {
    return EQ_BAND_FREQUENCIES_HZ.map((frequencyHz, i) => {
      const band = preset.bands[i];
      if (!band || !band.enabled) return neutralBand(clampF(frequencyHz), GRAPHIC_BAND_Q);
      return { frequencyHz: clampF(frequencyHz), gainDb: clampGain(band.gainDb), q: GRAPHIC_BAND_Q, type: 'peaking', enabled: true };
    });
  }
  return preset.bands.slice(0, MAX_BANDS).map((band) => {
    if (!band.enabled) return neutralBand(clampF(band.frequencyHz), band.q);
    return { frequencyHz: clampF(band.frequencyHz), gainDb: clampGain(band.gainDb), q: band.q, type: band.type, enabled: true };
  });
}

/** A preset-shaped object for the domain helpers, built from live engine values. */
export function liveEqPreset(base: EqPreset, preampDb: number, bands: readonly BandParams[]): EqPreset {
  return { ...base, preampDb, bands: [...bands] };
}

/** `-requiredHeadroomDb`: the trim that keeps the loudest boosted band at or below 0 dBFS. */
export function headroomTrimDb(preset: EqPreset): number {
  return -requiredHeadroomDb(preset);
}

/**
 * Level (dB relative to the untouched source) that the processed path averages to, measured as the
 * power mean of the combined response at the ten graphic centre frequencies, including preamp and
 * headroom trim. The bypass path is set to this so A/B compares tone, not loudness.
 */
export function matchedBypassLevelDb(preset: EqPreset, sampleRate = 48000): number {
  const curve = eqCurve(preset, EQ_BAND_FREQUENCIES_HZ, sampleRate);
  return powerMeanDb(curve) + headroomTrimDb(preset);
}
