import { describe, expect, it } from 'vitest';
import { profileSimilarity, tempoAffinity } from '../../src/similarity.js';
import { DEFAULT_RECOMMENDATION_CONFIG } from '../../src/config.js';

describe('tempo affinity', () => {
  it('is 1 at the same tempo, falls with distance, near 0 at 40 apart', () => {
    expect(tempoAffinity(120, 120)).toBe(1);
    expect(tempoAffinity(120, 130)).toBeCloseTo(Math.exp(-((10 / 12) ** 2)), 5);
    expect(tempoAffinity(120, 160)).toBeLessThan(0.01);
  });

  it('counts double and half time at 0.7', () => {
    expect(tempoAffinity(85, 170)).toBeCloseTo(0.7, 5);
    expect(tempoAffinity(170, 85)).toBeCloseTo(0.7, 5);
  });

  it('is 0 when either tempo is unknown', () => {
    expect(tempoAffinity(null, 120)).toBe(0);
    expect(tempoAffinity(120, undefined)).toBe(0);
  });
});

describe('profile similarity', () => {
  it('is cosine over the two profiles and 0 when one is empty', () => {
    expect(profileSimilarity({ rock: 1 }, { rock: 1 })).toBeCloseTo(1, 6);
    expect(profileSimilarity({ rock: 0.5, pop: 0.5 }, { rock: 1 })).toBeCloseTo(Math.SQRT1_2, 6);
    expect(profileSimilarity({}, { rock: 1 })).toBe(0);
    expect(profileSimilarity({ jazz: 1 }, { rock: 1 })).toBe(0);
  });
});

describe('ranking config', () => {
  it('has a tempo weight', () => {
    expect(DEFAULT_RECOMMENDATION_CONFIG.ranking.tempoFit).toBe(0.15);
  });
});
