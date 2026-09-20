/**
 * Original time-domain pitch shifter: two sweeping delay taps, windowed so their sum is unity
 * (MIT, ADR-0003).
 *
 * Design
 * ------
 * Input is written into a circular buffer at one sample per output sample. A read tap sits at a
 * delay that changes by `(1 − ratio)` every sample, so the tap advances through the recording at
 * `ratio` samples per output sample: reading faster than the writer (ratio > 1) raises pitch,
 * slower lowers it. That is the Doppler principle, and inside a sweep the pitch is *exactly*
 * `ratio` — no approximation. Read positions are fractional and linearly interpolated.
 *
 * A single tap cannot sweep for ever: it reaches the end of the window and has to jump back, and
 * that jump is a splice into an unrelated moment of the recording — a click. So there are two taps,
 * held exactly half a window apart, and each is weighted by a raised cosine over the full window:
 *
 *     g(d) = ½ − ½·cos(2π·d / window)
 *
 * which is 0 at `d = 0`, 1 at `d = window/2`, and 0 again at `d = window`. Because the taps are half
 * a window apart their arguments differ by π, so `g(dA) + g(dB) = 1` at every sample — the gains sum
 * to unity exactly, with no equal-power approximation and no gain dip. The decisive property is that
 * each tap's gain reaches zero precisely where that tap wraps, so the discontinuity is multiplied by
 * nothing. Neither tap is ever spliced in at an audible amplitude.
 *
 * The wrap period is `window / (|1 − ratio| · sampleRate)` seconds — about 0.72 s at a semitone
 * (ratio 1.0595) with the default 2048-sample window at 48 kHz, and about 0.17 s at ratio 1.25. That
 * is how often each tap crosses the window, not how often something audible happens: what is audible
 * is the slow comb between two taps half a window apart, heard as a gentle warble on sustained
 * tones, strongest at large ratios. That is the honest cost of this method.
 *
 * This is deliberately *not* overlap-add granular shifting with a fixed hop. Grains that are not
 * locked to the sweep drift apart by `(1 − ratio) · hop`, and the phase difference across their
 * crossfade cancels part of the intended shift. Here the two taps are locked half a window apart and
 * sweep together, so they carry the same shifted frequency and only their relative phase varies.
 *
 * `bypass` (or a ratio of exactly 1) routes the input straight to the output, bit-exact. Moving
 * between the dry and processed paths crossfades over `fadeSamples` so the time offset between them
 * does not click; in steady state the dry path is a pure copy.
 *
 * Latency: the weighted mean delay of the processed path stays near `windowSize / 2` (≈ 21 ms at
 * 48 kHz with the default 2048-sample window), swinging by roughly ±5 % of the window as the taps
 * sweep; the instantaneous delay of either tap ranges across the whole window. The dry path adds
 * none.
 *
 * Quality limits, stated plainly in the UI: two taps reading different moments of the recording comb
 * against each other, so sustained tones warble and transients can be doubled; linear interpolation
 * attenuates the top octave slightly at fractional read positions. Good for retuning a reference
 * pitch by tens of cents; not a studio time-stretcher.
 *
 * `scripts/measure-clicks.ts` prints the discontinuity measurement this design is judged by, and
 * `tests/unit/pitch-shifter.test.ts` pins it.
 */

export const PITCH_SHIFTER_PROCESSOR_NAME = 'np-pitch-shifter';
export const DEFAULT_GRAIN_SIZE_AT_48K = 2048;
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2;
export const MIN_GRAIN_SIZE = 64;

export interface PitchShifterParameterDescriptor {
  name: 'ratio';
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'k-rate';
}

/**
 * Shared with the AudioWorkletProcessor wrapper and the mock so all three agree.
 *
 * Ratio only. Bypass is a discrete switch rather than a ramped signal, so it travels over the
 * processor's port; declaring it here as well would let the graph write to a parameter the
 * processor does not read, which is a silent no-op and was one.
 */
export const PITCH_SHIFTER_PARAMETER_DESCRIPTORS: readonly PitchShifterParameterDescriptor[] = [
  { name: 'ratio', defaultValue: 1, minValue: MIN_RATIO, maxValue: MAX_RATIO, automationRate: 'k-rate' },
];

/**
 * Sweep window scaled from 2048 @ 48 kHz so the window is the same ≈ 43 ms at any sample rate
 * (and even, so half of it is a whole number of samples).
 */
export function defaultGrainSize(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive number');
  return normalizeGrainSize(Math.round((DEFAULT_GRAIN_SIZE_AT_48K * sampleRate) / 48000));
}

/** Windows must be even (the tap is re-centred at exactly half) and not tiny. */
export function normalizeGrainSize(grainSize: number): number {
  if (!Number.isFinite(grainSize)) throw new RangeError('grainSize must be a finite number');
  const n = Math.max(MIN_GRAIN_SIZE, Math.round(grainSize));
  return n % 2 === 0 ? n : n + 1;
}

/** Mean added latency of the processed path, in samples (half the sweep window). */
export function pitchShifterLatencySamples(sampleRate: number, grainSize: number = defaultGrainSize(sampleRate)): number {
  return normalizeGrainSize(grainSize) / 2;
}

export function sanitizeRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export interface PitchShifterCoreOptions {
  /**
   * Length of the dry/processed crossfade in samples. Default: an eighth of the window (≈ 5 ms at
   * 48 kHz). The taps themselves need no crossfade: their window already fades each one to zero
   * before it wraps.
   */
  fadeSamples?: number;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export class PitchShifterCore {
  readonly sampleRate: number;
  readonly channels: number;
  /** Length of the delay sweep, in samples. */
  readonly grainSize: number;
  readonly fadeSamples: number;

  private readonly half: number;
  private readonly mask: number;
  private readonly ring: Float32Array[];
  private write = 0;
  /**
   * Delay of the first tap, in samples (fractional), always inside `[0, grainSize)`.
   *
   * The second tap is held exactly half a window from it, so this one number places both.
   */
  private phase: number;
  /** 0 = dry (bit-exact copy), 1 = processed. Moves by 1/fadeSamples per sample. */
  private mix = 0;

  constructor(sampleRate: number, channels: number, grainSize: number = defaultGrainSize(sampleRate), options: PitchShifterCoreOptions = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive number');
    if (!Number.isInteger(channels) || channels < 1) throw new RangeError('channels must be a positive integer');
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.grainSize = normalizeGrainSize(grainSize);
    this.half = this.grainSize / 2;
    const fade = options.fadeSamples ?? Math.round(this.grainSize / 8);
    this.fadeSamples = Math.max(1, Math.min(Math.round(fade), Math.floor(this.half / 2)));
    const size = nextPowerOfTwo(this.grainSize + this.fadeSamples + 4);
    this.mask = size - 1;
    this.ring = Array.from({ length: channels }, () => new Float32Array(size));
    // Start where the first tap carries the whole signal and the second is silent, so engaging the
    // shifter begins at the middle of the window rather than part-way through a comb.
    this.phase = this.half;
  }

  /** Mean latency of the processed path in samples (the dry path adds none). */
  get latencySamples(): number {
    return this.half;
  }

  /** `true` while any processed signal is still audible (mix > 0). */
  get isProcessing(): boolean {
    return this.mix > 0;
  }

  /** Clear buffers and tap state (e.g. after a seek); the dry/processed mix is kept. */
  reset(): void {
    for (const buf of this.ring) buf.fill(0);
    this.write = 0;
    this.phase = this.half;
  }

  /**
   * Process one block. `inputs[ch]` / `outputs[ch]` are per-channel frame arrays of equal length.
   * Channels beyond `min(channels, inputs.length, outputs.length)` are zero-filled.
   */
  process(inputs: readonly Float32Array[], outputs: Float32Array[], ratio: number, bypass: boolean): void {
    const chans = Math.min(this.channels, inputs.length, outputs.length);
    for (let c = chans; c < outputs.length; c++) outputs[c]!.fill(0);
    if (chans === 0) return;
    let frames = inputs[0]!.length;
    for (let c = 0; c < chans; c++) frames = Math.min(frames, inputs[c]!.length, outputs[c]!.length);
    const r = sanitizeRatio(ratio);
    const target = bypass || r === 1 ? 0 : 1;
    if (target === 0 && this.mix === 0) {
      this.passThrough(inputs, outputs, chans, frames);
      return;
    }

    const mask = this.mask;
    const ring = this.ring;
    const window = this.grainSize;
    const half = this.half;
    const step = 1 - r;
    const fadeStep = 1 / this.fadeSamples;
    // The raised-cosine window, expressed as an angular rate over the delay.
    const omega = (2 * Math.PI) / window;
    let phase = this.phase;
    let w = this.write;
    let mix = this.mix;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chans; c++) ring[c]![w] = inputs[c]![i]!;

      if (mix !== target) {
        if (target > mix) mix = Math.min(target, mix + fadeStep);
        else mix = Math.max(target, mix - fadeStep);
      }

      // Two taps, half a window apart, so their window arguments differ by π. `gB = 1 - gA` is
      // therefore not an approximation but the identity cos(θ + π) = −cos(θ): the pair sums to unity
      // at every sample, and each gain is exactly zero where its own tap wraps — which is what keeps
      // the wrap from being spliced in at an audible amplitude.
      const delayA = phase;
      const delayB = phase >= half ? phase - half : phase + half;
      const gA = 0.5 - 0.5 * Math.cos(omega * delayA);
      const gB = 1 - gA;

      const readA = w - delayA;
      const iA = Math.floor(readA);
      const fA = readA - iA;
      const a0 = iA & mask;
      const a1 = (iA + 1) & mask;

      const readB = w - delayB;
      const iB = Math.floor(readB);
      const fB = readB - iB;
      const b0 = iB & mask;
      const b1 = (iB + 1) & mask;

      for (let c = 0; c < chans; c++) {
        const buf = ring[c]!;
        const sA = buf[a0]!;
        const sB = buf[b0]!;
        const wet = gA * (sA + (buf[a1]! - sA) * fA) + gB * (sB + (buf[b1]! - sB) * fB);
        if (mix === 1) {
          outputs[c]![i] = wet;
        } else {
          const dry = inputs[c]![i]!;
          outputs[c]![i] = dry + (wet - dry) * mix;
        }
      }

      // |step| = |1 − ratio| ≤ 1 across the allowed ratio range, so one correction always suffices
      // and the delay can never leave [0, window) — the defect in the single-tap version was exactly
      // a delay that kept stepping past the end of the window and went negative.
      phase += step;
      if (phase >= window) phase -= window;
      else if (phase < 0) phase += window;
      w = (w + 1) & mask;
    }

    this.phase = phase;
    this.write = w;
    this.mix = mix;
  }

  /** Bit-exact copy that still fills the ring buffer, so re-engaging the shifter has history to read. */
  private passThrough(inputs: readonly Float32Array[], outputs: Float32Array[], chans: number, frames: number): void {
    const mask = this.mask;
    const ring = this.ring;
    let w = this.write;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chans; c++) {
        const x = inputs[c]![i]!;
        ring[c]![w] = x;
        outputs[c]![i] = x;
      }
      w = (w + 1) & mask;
    }
    this.write = w;
    // A fresh engagement always starts from the middle of the window.
    this.phase = this.half;
  }
}
