import { describe, expect, it } from 'vitest';
import { centsFromReference, describeRetune, ratioFromCents, validateReference } from '../../src/retune.js';

describe('retune', () => {
  it('computes cents from reference tuning', () => {
    expect(centsFromReference(440)).toBe(0);
    expect(centsFromReference(432)).toBeCloseTo(-31.767, 3);
    expect(centsFromReference(444)).toBeCloseTo(15.667, 3);
    expect(ratioFromCents(1200)).toBe(2);
    expect(ratioFromCents(-31.767)).toBeCloseTo(432 / 440, 5);
  });
  it('validates the custom range', () => {
    expect(validateReference(432).ok).toBe(true);
    expect(validateReference(528).ok).toBe(false);
    expect(validateReference(Number.NaN).ok).toBe(false);
  });
  it('describes modes honestly', () => {
    const linked = describeRetune({ referenceHz: 432, pitchOffsetCents: 0, mode: 'linked-speed' });
    expect(linked.honestNote).toContain('pitch AND tempo change together');
    expect(linked.durationFactor).toBeCloseTo(440 / 432, 5);
    const preserve = describeRetune({ referenceHz: 432, pitchOffsetCents: 0, mode: 'preserve-tempo' });
    expect(preserve.durationFactor).toBe(1);
    expect(preserve.honestNote).not.toContain('converted');
    expect(describeRetune({ referenceHz: 440, pitchOffsetCents: 0, mode: 'preserve-tempo' }).active).toBe(false);
  });
});
