import { z } from 'zod';
import { IsoDateTime, SyncedEntityBase, Uuid } from '../common.js';

export const EQ_BAND_FREQUENCIES_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_GAIN_MIN_DB = -12;
export const EQ_GAIN_MAX_DB = 12;
export const EQ_PREAMP_MIN_DB = -12;
export const EQ_PREAMP_MAX_DB = 12;

export const EqFilterType = z.enum(['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass']);
export type EqFilterType = z.infer<typeof EqFilterType>;

export const EqBand = z.object({
  frequencyHz: z.number().min(10).max(24000),
  gainDb: z.number().min(EQ_GAIN_MIN_DB).max(EQ_GAIN_MAX_DB),
  q: z.number().min(0.05).max(36).default(1.1),
  type: EqFilterType.default('peaking'),
  enabled: z.boolean().default(true),
});
export type EqBand = z.infer<typeof EqBand>;

export const EqPresetKind = z.enum(['builtin', 'user', 'imported']);
export const EqMode = z.enum(['graphic', 'parametric']);

export const EqPreset = SyncedEntityBase.extend({
  name: z.string().min(1).max(60),
  kind: EqPresetKind.default('user'),
  mode: EqMode.default('graphic'),
  preampDb: z.number().min(EQ_PREAMP_MIN_DB).max(EQ_PREAMP_MAX_DB).default(0),
  bands: z.array(EqBand).min(1).max(32),
  description: z.string().max(200).nullable().default(null),
});
export type EqPreset = z.infer<typeof EqPreset>;

export const EqBindingScope = z.enum(['global', 'playlist', 'track', 'playlist-track']);
export type EqBindingScope = z.infer<typeof EqBindingScope>;

/**
 * Binding of a preset to a scope. Precedence (highest first):
 * playlist-track > track > playlist > global > Flat.
 */
export const EqBinding = SyncedEntityBase.extend({
  scope: EqBindingScope,
  playlistId: Uuid.nullable().default(null),
  trackId: Uuid.nullable().default(null),
  presetId: Uuid,
});
export type EqBinding = z.infer<typeof EqBinding>;

export const RetuneMode = z.enum(['off', 'preserve-tempo', 'linked-speed']);
export type RetuneMode = z.infer<typeof RetuneMode>;

export const RetuneConfig = z.object({
  referenceHz: z.number().min(400).max(480).default(440).describe('A4 reference frequency'),
  pitchOffsetCents: z.number().min(-1200).max(1200).default(0).describe('Additional manual offset'),
  mode: RetuneMode.default('off'),
  updatedAt: IsoDateTime,
});
export type RetuneConfig = z.infer<typeof RetuneConfig>;

export const AudioSettings = z.object({
  eqEnabled: z.boolean().default(true),
  eqBypassed: z.boolean().default(false),
  limiterEnabled: z.boolean().default(true),
  outputGainDb: z.number().min(-30).max(0).default(0),
  retune: RetuneConfig,
  updatedAt: IsoDateTime,
});
export type AudioSettings = z.infer<typeof AudioSettings>;

export const ResolvedEq = z.object({
  presetId: Uuid.nullable(),
  presetName: z.string(),
  source: z.enum(['playlist-track', 'track', 'playlist', 'global', 'flat']),
  explanation: z.string().describe('e.g. "Club EQ — overridden for this song in Road Trip"'),
});
export type ResolvedEq = z.infer<typeof ResolvedEq>;
