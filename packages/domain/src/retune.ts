import type { RetuneConfig } from '@now-playing/contracts';

export const STANDARD_A4_HZ = 440;
export const COMMON_REFERENCES = [
  { hz: 415, label: '415 Hz (baroque)' },
  { hz: 432, label: '432 Hz' },
  { hz: 440, label: '440 Hz (standard)' },
  { hz: 442, label: '442 Hz (orchestral)' },
  { hz: 444, label: '444 Hz' },
] as const;

export const REFERENCE_MIN_HZ = 400;
export const REFERENCE_MAX_HZ = 480;

/** cents = 1200 * log2(targetA4 / 440) */
export function centsFromReference(targetA4Hz: number, baseA4Hz: number = STANDARD_A4_HZ): number {
  if (targetA4Hz <= 0 || baseA4Hz <= 0) throw new RangeError('Frequencies must be positive');
  return 1200 * Math.log2(targetA4Hz / baseA4Hz);
}

export function ratioFromCents(cents: number): number {
  return 2 ** (cents / 1200);
}

export function centsFromRatio(ratio: number): number {
  return 1200 * Math.log2(ratio);
}

export function semitonesFromCents(cents: number): number {
  return cents / 100;
}

export function validateReference(hz: number): { ok: boolean; reason?: string } {
  if (!Number.isFinite(hz)) return { ok: false, reason: 'Reference must be a number' };
  if (hz < REFERENCE_MIN_HZ || hz > REFERENCE_MAX_HZ) return { ok: false, reason: `Reference must be between ${REFERENCE_MIN_HZ} and ${REFERENCE_MAX_HZ} Hz` };
  return { ok: true };
}

export interface RetuneDescription {
  referenceCents: number;
  offsetCents: number;
  totalCents: number;
  ratio: number;
  semitones: number;
  active: boolean;
  modeLabel: string;
  /** What actually changes, stated plainly. */
  honestNote: string;
  /** Approximate duration factor (1 = unchanged). */
  durationFactor: number;
}

export function describeRetune(config: Pick<RetuneConfig, 'referenceHz' | 'pitchOffsetCents' | 'mode'>): RetuneDescription {
  const referenceCents = centsFromReference(config.referenceHz);
  const totalCents = referenceCents + config.pitchOffsetCents;
  const ratio = ratioFromCents(totalCents);
  const active = config.mode !== 'off' && Math.abs(totalCents) > 0.01;
  const modeLabel = config.mode === 'preserve-tempo' ? 'Preserve tempo (pitch shift)' : config.mode === 'linked-speed' ? 'Linked speed (pitch and tempo change together)' : 'Off';
  const honestNote =
    config.mode === 'off'
      ? 'Audio is played back unchanged.'
      : config.mode === 'preserve-tempo'
        ? `Every pitch is shifted by ${totalCents.toFixed(1)} cents (ratio ${ratio.toFixed(5)}) with a granular time-domain pitch shifter; duration is preserved. This retunes the recording's A4 from 440 Hz to ${config.referenceHz} Hz; it does not "convert the song to a frequency".`
        : `Playback rate is set to ${ratio.toFixed(5)}: pitch AND tempo change together (duration ×${(1 / ratio).toFixed(4)}). Tempo is not preserved in this mode.`;
  return { referenceCents, offsetCents: config.pitchOffsetCents, totalCents, ratio, semitones: semitonesFromCents(totalCents), active, modeLabel, honestNote, durationFactor: config.mode === 'linked-speed' && active ? 1 / ratio : 1 };
}
