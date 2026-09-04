/**
 * Structural ("-Like") views of the Web Audio objects the engine touches.
 *
 * The engine is written against these interfaces instead of the DOM classes so that a real
 * `AudioContext` (browser, Electron renderer) and the `MockAudioContext` test double are both
 * accepted without casts. Every real DOM object satisfies its "-Like" view structurally.
 */
import type { EqFilterType, RetuneMode } from '@now-playing/contracts';
import type { RetuneDescription } from '@now-playing/domain';

/** The subset of `AudioParam` the engine drives. `.value` is only ever *read* (to anchor ramps). */
export interface AudioParamLike {
  value: number;
  readonly defaultValue: number;
  readonly minValue: number;
  readonly maxValue: number;
  setValueAtTime(value: number, startTime: number): AudioParamLike;
  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParamLike;
  cancelScheduledValues(cancelTime: number): AudioParamLike;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike, output?: number, input?: number): AudioNodeLike;
  disconnect(): void;
  disconnect(destination: AudioNodeLike): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
  readonly gain: AudioParamLike;
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
  readonly reduction: number;
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  readonly frequencyBinCount: number;
  smoothingTimeConstant: number;
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void;
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void;
}

/**
 * The media-element surface the engine reads and writes. `HTMLMediaElement` satisfies it; the
 * vendor-prefixed flags are only written when the element actually has them.
 */
export interface RetunableMediaElement {
  playbackRate: number;
  preservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  readonly currentSrc?: string;
  src?: string;
  crossOrigin?: string | null;
  srcObject?: unknown;
}

export interface MediaElementSourceNodeLike extends AudioNodeLike {
  readonly mediaElement: RetunableMediaElement;
}

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
}

export interface BufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface WorkletNodeOptionsLike {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterData?: Record<string, number>;
  /** Passed to the processor constructor (`options.processorOptions`), e.g. `{ grainSize }`. */
  processorOptions?: Record<string, unknown>;
}

export interface WorkletNodeLike extends AudioNodeLike {
  readonly parameters: { get(name: string): AudioParamLike | undefined };
  /** Message channel to the processor (`{ type: 'reset' }` clears its grain buffers). */
  readonly port?: { postMessage(message: unknown): void };
}

export interface AudioWorkletLike {
  addModule(moduleUrl: string | URL): Promise<void>;
}

/**
 * What `createAudioEngine` needs from a context. A real `AudioContext` satisfies this as-is.
 * `createWorkletNode` is a non-standard hook used by `MockAudioContext`; real contexts go
 * through the global `AudioWorkletNode` constructor.
 */
export interface EngineContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: AudioContextState;
  readonly destination: AudioNodeLike;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly audioWorklet?: AudioWorkletLike;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createDynamicsCompressor(): DynamicsCompressorNodeLike;
  createAnalyser(): AnalyserNodeLike;
  createMediaElementSource(element: RetunableMediaElement): MediaElementSourceNodeLike;
  createBufferSource(): BufferSourceNodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  addEventListener?(type: 'statechange', listener: () => void): void;
  removeEventListener?(type: 'statechange', listener: () => void): void;
  createWorkletNode?(name: string, options?: WorkletNodeOptionsLike): WorkletNodeLike;
}

/** Latency budget in milliseconds. `outputMs` is `null` when the browser does not expose it. */
export interface LatencyReport {
  baseMs: number;
  outputMs: number | null;
  workletMs: number;
  totalMs: number;
}

/** How the current retune request is realised. */
export type RetuneApplication = 'worklet' | 'playback-rate' | 'none';

export interface RetuneState {
  mode: RetuneMode;
  referenceHz: number;
  pitchOffsetCents: number;
  totalCents: number;
  /** The ratio actually applied: `ratioFromCents(totalCents)` clamped to the shifter's MIN_RATIO…MAX_RATIO. */
  ratio: number;
  /** `true` when the requested ratio fell outside MIN_RATIO…MAX_RATIO; `description.ratio` keeps the unclamped value. */
  ratioClamped: boolean;
  active: boolean;
  /** `true` once the pitch-shifter worklet is loaded and inserted into the graph. */
  workletAvailable: boolean;
  /** Why the worklet is missing, when it is. */
  workletError: string | null;
  applied: RetuneApplication;
  description: RetuneDescription;
}

export interface AudioEngineState {
  contextState: AudioContextState;
  dspAvailable: boolean;
  dspUnavailableReason: string | null;
  bypassed: boolean;
  presetId: string | null;
  presetName: string;
  /** `true` after `setBandGain`/`setPreamp` changed values away from the applied preset. */
  presetModified: boolean;
  preampDb: number;
  outputGainDb: number;
  limiterEnabled: boolean;
  /** Always ≤ 0: `-requiredHeadroomDb(current bands + preamp)`. */
  headroomTrimDb: number;
  /** Level (dB re. the source) the bypass path is matched to. */
  bypassMatchedGainDb: number;
  bandCount: number;
  bands: ReadonlyArray<{ frequencyHz: number; gainDb: number; q: number; type: EqFilterType; enabled: boolean }>;
  retune: RetuneState;
  latency: LatencyReport;
  disposed: boolean;
}

export type AudioEngineListener = (state: AudioEngineState) => void;
