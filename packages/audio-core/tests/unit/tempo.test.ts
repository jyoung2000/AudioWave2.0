import { describe, expect, it } from 'vitest';
import { estimateTempo } from '../../src/tempo.js';

/** Sharp clicks at a steady tempo: the simplest signal with a beat, and one whose answer is known. */
function clicks(bpm: number, seconds: number, sampleRate = 22050): Float32Array {
  const out = new Float32Array(seconds * sampleRate);
  const period = (60 / bpm) * sampleRate;
  for (let t = 0; t < out.length; t += period) {
    const start = Math.round(t);
    for (let i = 0; i < 200 && start + i < out.length; i++) out[start + i] = (1 - i / 200) * (i % 2 ? 1 : -1);
  }
  return out;
}

describe('estimateTempo', () => {
  it.each([90, 120, 174])('hears %d bpm clicks within one beat per minute', (bpm) => {
    const r = estimateTempo(clicks(bpm, 20), 22050);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.bpm - bpm)).toBeLessThanOrEqual(1);
    expect(r!.confidence).toBeGreaterThan(1.5);
  });

  it('folds a very slow pulse into the 70–180 window', () => {
    expect(estimateTempo(clicks(50, 20), 22050)!.bpm).toBe(100);
  });

  it('returns null for silence and for clips shorter than eight seconds', () => {
    expect(estimateTempo(new Float32Array(22050 * 20), 22050)).toBeNull();
    expect(estimateTempo(clicks(120, 4), 22050)).toBeNull();
  });
});
