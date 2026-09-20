import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAIN_SIZE_AT_48K,
  MAX_RATIO,
  MIN_RATIO,
  PITCH_SHIFTER_PARAMETER_DESCRIPTORS,
  PITCH_SHIFTER_PROCESSOR_NAME,
  PitchShifterCore,
  defaultGrainSize,
  estimateFundamentalHz,
  makeSine,
  maxAbsDifference,
  normalizeGrainSize,
  pitchShifterLatencySamples,
  renderThroughCore,
  rms,
  sanitizeRatio,
} from '../../src/index.js';

const SR = 48000;
const A4 = 440;

/** Largest step between consecutive samples — the thing a click is. */
function maxJump(samples: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i]! - samples[i - 1]!));
  return worst;
}

describe('pitch shifter core', () => {
  it('exposes the parameters the worklet declares', () => {
    expect(PITCH_SHIFTER_PROCESSOR_NAME).toBe('np-pitch-shifter');
    // Ratio only: bypass is a port message, and a declared-but-unread parameter is a silent no-op.
    expect(PITCH_SHIFTER_PARAMETER_DESCRIPTORS.map((d) => d.name)).toEqual(['ratio']);
    const ratio = PITCH_SHIFTER_PARAMETER_DESCRIPTORS[0]!;
    expect(ratio.minValue).toBe(MIN_RATIO);
    expect(ratio.maxValue).toBe(MAX_RATIO);
    expect(ratio.automationRate).toBe('k-rate');
  });

  it('scales the grain size with the sample rate and keeps it even', () => {
    expect(defaultGrainSize(48000)).toBe(DEFAULT_GRAIN_SIZE_AT_48K);
    expect(defaultGrainSize(44100) % 2).toBe(0);
    expect(defaultGrainSize(96000)).toBe(4096);
    expect(normalizeGrainSize(1025)).toBe(1026);
    expect(normalizeGrainSize(4)).toBe(64);
    expect(() => defaultGrainSize(0)).toThrow(RangeError);
  });

  it('reports latency as half a grain', () => {
    expect(pitchShifterLatencySamples(SR)).toBe(DEFAULT_GRAIN_SIZE_AT_48K / 2);
    const core = new PitchShifterCore(SR, 2, 2048);
    expect(core.latencySamples).toBe(1024);
    expect((core.latencySamples / SR) * 1000).toBeCloseTo(21.33, 1);
  });

  it('sanitises ratios', () => {
    expect(sanitizeRatio(1)).toBe(1);
    expect(sanitizeRatio(Number.NaN)).toBe(1);
    expect(sanitizeRatio(10)).toBe(MAX_RATIO);
    expect(sanitizeRatio(0.01)).toBe(MIN_RATIO);
  });

  it('is bit-exact at ratio 1', () => {
    const input = makeSine(A4, SR, 0.25);
    const output = renderThroughCore(input, SR, 1);
    expect(maxAbsDifference(input, output)).toBe(0);
  });

  it('is bit-exact when bypassed even with a shifted ratio', () => {
    const input = makeSine(A4, SR, 0.25);
    const output = renderThroughCore(input, SR, 1.5, { bypass: true });
    expect(maxAbsDifference(input, output)).toBe(0);
  });

  it('shifts a 440 Hz tone up a semitone to within 1 %', () => {
    const input = makeSine(A4, SR, 1);
    const ratio = 2 ** (1 / 12);
    const output = renderThroughCore(input, SR, ratio);
    const steady = output.subarray(SR / 2);
    const measured = estimateFundamentalHz(steady, SR);
    expect(measured).not.toBeNull();
    expect(Math.abs(measured! - A4 * ratio) / (A4 * ratio)).toBeLessThan(0.01);
  });

  it('shifts down to a 432 Hz reference to within 1 %', () => {
    const input = makeSine(A4, SR, 1);
    const ratio = 432 / 440;
    const output = renderThroughCore(input, SR, ratio);
    const measured = estimateFundamentalHz(output.subarray(SR / 2), SR);
    expect(measured).not.toBeNull();
    expect(Math.abs(measured! - A4 * ratio) / (A4 * ratio)).toBeLessThan(0.01);
  });

  it('keeps the output at a comparable level (the two grains sum to unity)', () => {
    const input = makeSine(A4, SR, 1, 0.5);
    const output = renderThroughCore(input, SR, 2 ** (2 / 12));
    const inLevel = rms(input, SR / 2);
    const outLevel = rms(output, SR / 2);
    expect(outLevel).toBeGreaterThan(inLevel * 0.7);
    expect(outLevel).toBeLessThan(inLevel * 1.3);
  });

  it('never exceeds the input peak, because the two tap gains sum to unity', () => {
    // The single-tap version crossfaded with equal-power gains, which sum to √2 when the two taps
    // happen to align, so it could overshoot by 3 dB and leaned on the chain limiter to catch it.
    // The raised-cosine pair sums to exactly 1 at every sample, so there is no overshoot to catch.
    for (const ratio of [0.5, 1.25, 1.5, 2]) {
      const input = makeSine(A4, SR, 0.5, 0.9);
      const output = renderThroughCore(input, SR, ratio);
      let peak = 0;
      for (const s of output) peak = Math.max(peak, Math.abs(s));
      expect(peak, `ratio ${ratio} peaked at ${peak}`).toBeLessThanOrEqual(0.9 + 1e-6);
    }
  });

  /**
   * The gate on the defect this design replaced.
   *
   * A click is a step in the waveform, so the measurement is the largest jump between consecutive
   * samples. A tap reading `ratio` times faster than it writes legitimately steepens the wave by
   * `ratio`, and `ratio` never exceeds 2 — so anything past twice the input's own largest step is a
   * splice, not a slope. The single-tap version scored 2.2× at a semitone and 8.8× at ratio 1.25,
   * because mid-crossfade its outgoing tap stepped past the end of the window, went negative, and
   * read a whole ring buffer of stale audio. `scripts/measure-clicks.ts` prints the table.
   */
  it('introduces no discontinuity larger than the shift itself justifies', () => {
    const input = makeSine(A4, SR, 2, 0.5);
    const reference = maxJump(input);
    for (const ratio of [0.9438, 1.0595, 1.25, 1.5]) {
      const jump = maxJump(renderThroughCore(input, SR, ratio));
      expect(jump / reference, `ratio ${ratio} stepped ${(jump / reference).toFixed(2)}× the input's largest step`).toBeLessThanOrEqual(2);
    }
  });

  it('stays finite over ten seconds at every ratio', () => {
    // Ten seconds is many hundreds of wraps at the larger ratios: long enough for a delay that
    // drifts out of range, or a gain that stops summing to one, to show up as a NaN or an infinity.
    for (const ratio of [MIN_RATIO, 0.9438, 1.0595, 1.25, MAX_RATIO]) {
      const output = renderThroughCore(makeSine(A4, SR, 10, 0.5), SR, ratio);
      const bad = output.findIndex((s) => !Number.isFinite(s));
      expect(bad, `ratio ${ratio} produced a non-finite sample at index ${bad}`).toBe(-1);
    }
  });

  it('processes stereo independently', () => {
    const core = new PitchShifterCore(SR, 2, 2048);
    const left = new Float32Array(128).fill(0.5);
    const right = new Float32Array(128).fill(-0.25);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    core.process([left, right], [outL, outR], 1, false);
    expect(Array.from(outL.subarray(0, 4))).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(Array.from(outR.subarray(0, 4))).toEqual([-0.25, -0.25, -0.25, -0.25]);
  });

  it('zero-fills output channels beyond the input', () => {
    const core = new PitchShifterCore(SR, 1, 2048);
    const input = new Float32Array(64).fill(0.3);
    const a = new Float32Array(64);
    const b = new Float32Array(64).fill(9);
    core.process([input], [a, b], 1, false);
    expect(b.every((v) => v === 0)).toBe(true);
  });

  it('reset clears the buffers without throwing', () => {
    const core = new PitchShifterCore(SR, 1, 2048);
    const input = new Float32Array(256).fill(0.4);
    const output = new Float32Array(256);
    core.process([input], [output], 1.2, false);
    expect(() => core.reset()).not.toThrow();
    expect(core.isProcessing).toBe(true);
  });

  it('rejects impossible constructor arguments', () => {
    expect(() => new PitchShifterCore(0, 1)).toThrow(RangeError);
    expect(() => new PitchShifterCore(SR, 0)).toThrow(RangeError);
  });

  it('estimates pitch of a known tone accurately', () => {
    const tone = makeSine(220, SR, 0.5);
    expect(estimateFundamentalHz(tone, SR)!).toBeCloseTo(220, 0);
  });

  it('returns null for silence', () => {
    expect(estimateFundamentalHz(new Float32Array(4096), SR)).toBeNull();
  });
});
