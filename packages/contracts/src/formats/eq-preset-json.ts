import { z } from 'zod';
import { IsoDateTime, SCHEMA_VERSIONS } from '../common.js';
import { EqPreset } from '../entities/audio.js';

export const EQ_PRESET_JSON_FORMAT = 'now-playing-eq-preset' as const;

export const EqPresetJson = z.object({
  format: z.literal(EQ_PRESET_JSON_FORMAT),
  schemaVersion: z.literal(SCHEMA_VERSIONS.eqPresetJson),
  exportedAt: IsoDateTime,
  presets: z.array(EqPreset).min(1).max(200),
});
export type EqPresetJson = z.infer<typeof EqPresetJson>;
