/**
 * The solfeggio presets.
 *
 * What is worth pinning down is that they are *filters at the frequencies they name* — the failure
 * mode for a feature like this is a preset labelled "528 Hz" that quietly boosts the 500 Hz graphic
 * band instead, which would be a different thing wearing the right name.
 */
import { describe, expect, it } from 'vitest';
import { EqPreset } from '@now-playing/contracts';
import { ALL_BUILTIN_PRESETS, BUILTIN_PRESETS, c5FromA4, COMMON_REFERENCES, eqCurve, requiredHeadroomDb, SOLFEGGIO_FREQUENCIES, SOLFEGGIO_PRESETS } from '../../src/index.js';

describe('solfeggio presets', () => {
  it('are valid presets by the canonical schema', () => {
    for (const preset of SOLFEGGIO_PRESETS) expect(() => EqPreset.parse(preset)).not.toThrow();
  });

  it('put a band on each named frequency exactly, not on the nearest graphic slider', () => {
    for (const { hz } of SOLFEGGIO_FREQUENCIES) {
      const preset = SOLFEGGIO_PRESETS.find((p) => p.name.startsWith(`${hz} Hz`));
      expect(preset, `no preset for ${hz} Hz`).toBeDefined();
      expect(preset!.mode).toBe('parametric');
      expect(preset!.bands.map((b) => b.frequencyHz)).toEqual([hz]);
    }
    expect(SOLFEGGIO_PRESETS.at(-1)!.bands.map((b) => b.frequencyHz)).toEqual(SOLFEGGIO_FREQUENCIES.map((f) => f.hz));
  });

  it('actually boost at their own frequency and leave a neighbouring octave alone', () => {
    const preset = SOLFEGGIO_PRESETS.find((p) => p.name.startsWith('528 Hz'))!;
    const [atTarget, anOctaveBelow, anOctaveAbove] = eqCurve(preset, [528, 264, 1056]);
    // The curve includes the preset's preamp, so the boost is measured against that baseline.
    expect(atTarget! - preset.preampDb).toBeGreaterThan(5);
    // Q 4 is about a third of an octave, so a whole octave away should be close to untouched.
    expect(Math.abs(anOctaveBelow! - preset.preampDb)).toBeLessThan(1);
    expect(Math.abs(anOctaveAbove! - preset.preampDb)).toBeLessThan(1);
  });

  it('leave enough headroom that the boosts cannot clip', () => {
    for (const preset of SOLFEGGIO_PRESETS) {
      // The engine trims by this much; it only has to be a finite, sane number for the graph to
      // stay below full scale, and the nine-band preset is the one that could get out of hand.
      expect(requiredHeadroomDb(preset)).toBeLessThan(12);
    }
  });

  it('are offered alongside the tone presets, without displacing them', () => {
    expect(ALL_BUILTIN_PRESETS.slice(0, BUILTIN_PRESETS.length)).toEqual(BUILTIN_PRESETS);
    expect(ALL_BUILTIN_PRESETS).toHaveLength(BUILTIN_PRESETS.length + SOLFEGGIO_PRESETS.length);
    expect(new Set(ALL_BUILTIN_PRESETS.map((p) => p.id)).size).toBe(ALL_BUILTIN_PRESETS.length);
  });

  it('describe themselves as filters, and claim nothing beyond that', () => {
    for (const preset of SOLFEGGIO_PRESETS) {
      expect(preset.description).toBeTruthy();
      expect(preset.description!).not.toMatch(/heal|dna|chakra|repair|cure|anxiety|miracle|cell/i);
    }
  });
});

describe('tuning references', () => {
  it('label 444 Hz by the arithmetic rather than the folklore', () => {
    const option = COMMON_REFERENCES.find((r) => r.hz === 444)!;
    expect(option.label).toContain('528');
    expect(c5FromA4(444)).toBeCloseTo(528, 0);
  });

  it('still offers standard concert pitch as an option', () => {
    expect(COMMON_REFERENCES.some((r) => r.hz === 440 && /standard/i.test(r.label))).toBe(true);
  });
});
