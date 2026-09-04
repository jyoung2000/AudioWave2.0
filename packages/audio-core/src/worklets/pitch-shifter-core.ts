/**
 * Original time-domain pitch shifter: a sweeping delay line with a crossfade at wrap (MIT, ADR-0003).
 *
 * Design
 * ------
 * Input is written into a circular buffer at one sample per output sample. A read tap sits at a
 * delay that changes by `(1 − ratio)` every sample, so the tap advances through the recording at
 * `ratio` samples per output sample: reading faster than the writer (ratio > 1) raises pitch,
 * slower lowers it. That is the Doppler principle, and inside a sweep the pitch is *exactly*
 * `ratio` — no approximation. Read positions are fractional and linearly interpolated.
 *
 * The tap eventually reaches one end of the window, so it is reset to the middle and the old and
 * new taps are equal-power crossfaded over `fadeSamples`. Only the crossfade is imperfect, and it
 * is rare for the small ratios retune uses: at a semitone (ratio 1.0595) the tap takes roughly
 * 0.7 s to cross a 2048-sample window at 48 kHz, so ~5 ms in ~700 ms is faded. Large shifts wrap
 * far more often and audibly rougher, which the UI states plainly.
 *
 * This is deliberately *not* overlap-add granular shifting. Two permanently overlapping grains
 * drift apart by `(1 − ratio) · hop` and the phase sweep across the crossfade cancels most of the
 * intended shift — measurably so near ratio 1, exactly where retune lives. A single sweeping tap
 * has no such cancellation.
 *
 * `bypass` (or a ratio of exactly 1) routes the input straight to the output, bit-exact. Moving
 * between the dry and processed paths crossfades over `fadeSamples` so the ≈ half-window time
 * offset between them does not click; in steady state the dry path is a pure copy.
 *
 * Latency: the tap is re-centred at half the window, so the mean added latency of the processed
 * path is `windowSize / 2` (≈ 21 ms at 48 kHz with the default 2048-sample window); the
 * instantaneous delay ranges across the window. The dry path adds none.
 *
 * Quality limits, stated plainly in the UI: each wrap splices two unrelated moments of the
 * recording, so sustained tones show a brief warble there and transients can be doubled or
 * clipped; linear interpolation attenuates the top octave slightly at fractional read positions.
 * Good for retuning a reference pitch by tens of cents; not a studio time-stretcher.
 */

export const PITCH_SHIFTER_PROCESSOR_NAME = 'np-pitch-shifter';
export const DEFAULT_GRAIN_SIZE_AT_48K = 2048;
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2;
export const MIN_GRAIN_SIZE = 64;

export interface PitchShifterParameterDescriptor {
  name: 'ratio' | 'bypass';
  defaultValue: number;
  minValue: number;
  maxValue: number;
  automationRate: 'k-rate';
}

/** Shared with the AudioWorkletProcessor wrapper and the mock so all three agree. */
export const PITCH_SHIFTER_PARAMETER_DESCRIPTORS: readonly PitchShifterParameterDescriptor[] = [
  { name: 'ratio', defaultValue: 1, minValue: MIN_RATIO, maxValue: MAX_RATIO, automationRate: 'k-rate' },
  { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
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
  /** Length of every crossfade in samples. Default: an eighth of the window (≈ 5 ms at 48 kHz). */
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
  /** Smallest and largest delay the sweeping tap may take before it is re-centred. */
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private write = 0;
  /** Delay of the live tap, in samples (fractional). */
  private delay: number;
  /** Delay of the tap being faded out; only meaningful while `fadePos >= 0`. */
  private fadeDelay = 0;
  /** Position inside the wrap crossfade, or −1 when no wrap fade is in progress. */
  private fadePos = -1;
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
    this.minDelay = 1;
    this.maxDelay = this.grainSize - 1;
    this.delay = this.half;
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
    this.delay = this.half;
    this.fadeDelay = 0;
    this.fadePos = -1;
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
    const step = 1 - r;
    const fadeStep = 1 / this.fadeSamples;
    let delay = this.delay;
    let fadeDelay = this.fadeDelay;
    let fadePos = this.fadePos;
    let w = this.write;
    let mix = this.mix;

    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < chans; c++) ring[c]![w] = inputs[c]![i]!;

      if (mix !== target) {
        if (target > mix) mix = Math.min(target, mix + fadeStep);
        else mix = Math.max(target, mix - fadeStep);
      }

      // Equal-power weights across a wrap crossfade; outside one, the live tap is alone.
      const fading = fadePos >= 0;
      const x = fading ? fadePos / this.fadeSamples : 1;
      const gNew = fading ? Math.sin((x * Math.PI) / 2) : 1;
      const gOld = fading ? Math.cos((x * Math.PI) / 2) : 0;

      const readNew = w - delay;
      const iNew = Math.floor(readNew);
      const fNew = readNew - iNew;
      const n0 = iNew & mask;
      const n1 = (iNew + 1) & mask;
      let o0 = 0;
      let o1 = 0;
      let fOld = 0;
      if (fading) {
        const readOld = w - fadeDelay;
        const iOld = Math.floor(readOld);
        fOld = readOld - iOld;
        o0 = iOld & mask;
        o1 = (iOld + 1) & mask;
      }

      for (let c = 0; c < chans; c++) {
        const buf = ring[c]!;
        const sNew = buf[n0]!;
        let wet = gNew * (sNew + (buf[n1]! - sNew) * fNew);
        if (fading) {
          const sOld = buf[o0]!;
          wet += gOld * (sOld + (buf[o1]! - sOld) * fOld);
        }
        if (mix === 1) {
          outputs[c]![i] = wet;
        } else {
          const dry = inputs[c]![i]!;
          outputs[c]![i] = dry + (wet - dry) * mix;
        }
      }

      delay += step;
      if (fading) {
        fadeDelay += step;
        fadePos += 1;
        if (fadePos >= this.fadeSamples) fadePos = -1;
      } else if (delay < this.minDelay || delay > this.maxDelay) {
        // The tap reached the end of the window: re-centre it and crossfade from the old position.
        fadeDelay = delay;
        delay = this.half;
        fadePos = 0;
      }
      w = (w + 1) & mask;
    }

    this.delay = delay;
    this.fadeDelay = fadeDelay;
    this.fadePos = fadePos;
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
    this.delay = this.half;
    this.fadePos = -1;
  }
}
