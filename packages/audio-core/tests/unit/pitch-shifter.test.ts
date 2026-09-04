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

describe('pitch shifter core', () => {
  it('exposes the parameters the worklet declares', () => {
    expect(PITCH_SHIFTER_PROCESSOR_NAME).toBe('np-pitch-shifter');
    expect(PITCH_SHIFTER_PARAMETER_DESCRIPTORS.map((d) => d.name)).toEqual(['ratio', 'bypass']);
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

  it('keeps the peak within the equal-power crossfade bound (√2), which the chain limiter catches', () => {
    const input = makeSine(A4, SR, 0.5, 0.9);
    const output = renderThroughCore(input, SR, 1.25);
    let peak = 0;
    for (const s of output) peak = Math.max(peak, Math.abs(s));
    // Two taps splice unrelated moments during a wrap; equal-power gains can sum to √2 when they
    // happen to align. That is why the graph puts a −1 dBFS limiter after the EQ.
    expect(peak).toBeLessThanOrEqual(0.9 * Math.SQRT2);
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
