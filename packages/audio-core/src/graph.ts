/**
 * The DSP chain (docs/architecture/AUDIO_PIPELINE.md):
 *
 *   source → preamp → [retune worklet] → EQ bands → headroom trim → limiter → analyser → output → destination
 *                  ↘─────────────── bypass (matched gain) ───────────────↗
 *
 * Every audible parameter is ramped, never jumped: `setPreamp`, `setBandGain`, the headroom trim
 * and the output gain use `linearRampToValueAtTime`; filter frequency/Q glide with
 * `setTargetAtTime`. Bypass crossfades the processed and matched-dry paths over 30 ms, so A/B
 * compares tone rather than loudness.
 *
 * The engine reports state honestly. A source that cannot enter the graph (cross-origin media
 * without CORS) is refused *before* a source node is created — the element keeps playing untouched
 * and `dspAvailable` is false with a reason. Retune says which mechanism actually applied:
 * `worklet` (pitch shifted, tempo preserved), `playback-rate` (pitch and tempo together) or
 * `none` with `workletError` when the worklet could not be loaded.
 */
import { EQ_BAND_FREQUENCIES_HZ, type EqPreset, type RetuneConfig } from '@now-playing/contracts';
import { describeRetune, FLAT_PRESET, requiredHeadroomDb, type RetuneDescription } from '@now-playing/domain';
import { DSP_UNAVAILABLE_REASON, currentPageOrigin, isCrossOriginWithoutCors, setPlaybackRate, setPreservesPitch } from './media-source.js';
import { BYPASS_CROSSFADE_MS, DEFAULT_RAMP_MS, clamp, dbToGain, glideParam, initParam, rampParam } from './params.js';
import { GRAPHIC_BAND_Q, MAX_BANDS, headroomTrimDb, liveEqPreset, matchedBypassLevelDb, maxFilterFrequencyHz, presetToBandParams, type BandParams } from './presets.js';
import type {
  AnalyserNodeLike,
  AudioEngineListener,
  AudioEngineState,
  AudioNodeLike,
  BiquadFilterNodeLike,
  BufferSourceNodeLike,
  DynamicsCompressorNodeLike,
  EngineContext,
  GainNodeLike,
  LatencyReport,
  MediaElementSourceNodeLike,
  RetunableMediaElement,
  RetuneApplication,
  RetuneState,
  WorkletNodeLike,
} from './types.js';
import { MAX_RATIO, MIN_RATIO, defaultGrainSize, pitchShifterLatencySamples, sanitizeRatio } from './worklets/pitch-shifter-core.js';
import { createPitchShifterNode, errorMessage, loadPitchShifterWorklet, type WorkletLoadResult } from './worklets/loader.js';

/** Safety limiter: −1 dBFS ceiling, hard knee, high ratio, fast attack (spec §"Headroom"). */
export const LIMITER_SETTINGS = { thresholdDb: -1, knee: 0, ratio: 20, attackSeconds: 0.001, releaseSeconds: 0.05 } as const;
export const ANALYSER_FFT_SIZE = 2048;
export const ANALYSER_SMOOTHING = 0.8;

export interface AudioEngineOptions {
  /** Bands to allocate; the graphic profile uses the ten fixed frequencies. Default 10, max 32. */
  bandCount?: number;
  /** Default ramp for gain changes, in milliseconds. */
  rampMs?: number;
  /** URL of the built pitch-shifter worklet module; without it retune falls back to playback rate. */
  workletModuleUrl?: string | URL | null;
  /** Preset applied at construction. Default `FLAT_PRESET`. */
  preset?: EqPreset;
  /** Start with the limiter engaged. Default true. */
  limiterEnabled?: boolean;
  /** Output gain in dB (≤ 0). Default 0. */
  outputGainDb?: number;
  /**
   * Origin the media is being played from, used to decide whether an element can enter the graph.
   * Defaults to the page origin; supply it explicitly in tests and in Electron, where the renderer
   * origin (`file://`, `app://`) is not what the media is compared against.
   */
  pageOrigin?: string | null;
}

export interface AttachResult {
  ok: boolean;
  reason: string | null;
}

export interface AudioEngine {
  readonly context: EngineContext;
  attachMediaElement(element: RetunableMediaElement): AttachResult;
  attachBufferSource(node: BufferSourceNodeLike): AttachResult;
  detach(): void;
  applyPreset(preset: EqPreset, options?: { rampMs?: number }): void;
  setBandGain(index: number, gainDb: number, options?: { rampMs?: number }): void;
  setBandEnabled(index: number, enabled: boolean): void;
  setPreamp(db: number, options?: { rampMs?: number }): void;
  setBypass(bypassed: boolean): void;
  setLimiter(enabled: boolean): void;
  setOutputGain(db: number, options?: { rampMs?: number }): void;
  setRetune(config: RetuneConfig): Promise<RetuneState>;
  getState(): AudioEngineState;
  subscribe(listener: AudioEngineListener): () => void;
  getAnalyserData(target: Uint8Array<ArrayBuffer>, kind?: 'frequency' | 'time'): void;
  getLatency(): LatencyReport;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  dispose(): void;
}

const OFF_RETUNE: RetuneConfig = { referenceHz: 440, pitchOffsetCents: 0, mode: 'off', updatedAt: new Date(0).toISOString() };

export function createAudioEngine(context: EngineContext, options: AudioEngineOptions = {}): AudioEngine {
  const rampDefault = options.rampMs ?? DEFAULT_RAMP_MS;
  const bandCount = clamp(Math.round(options.bandCount ?? EQ_BAND_FREQUENCIES_HZ.length), 1, MAX_BANDS);
  const now = () => context.currentTime;

  /* ---- nodes ---- */
  const preamp: GainNodeLike = context.createGain();
  const bands: BiquadFilterNodeLike[] = [];
  const trim: GainNodeLike = context.createGain();
  const limiter: DynamicsCompressorNodeLike = context.createDynamicsCompressor();
  const limiterBypass: GainNodeLike = context.createGain();
  const analyser: AnalyserNodeLike = context.createAnalyser();
  const output: GainNodeLike = context.createGain();
  const processedIn: GainNodeLike = context.createGain();
  const dryPath: GainNodeLike = context.createGain();

  let preset: EqPreset = options.preset ?? FLAT_PRESET;
  let bandParams: BandParams[] = presetToBandParams(preset, context.sampleRate);
  let preampDb = preset.preampDb;
  let outputGainDb = options.outputGainDb ?? 0;
  let limiterEnabled = options.limiterEnabled ?? true;
  let bypassed = false;
  let presetModified = false;
  let disposed = false;

  /* Build the fixed part of the chain. `processedIn` is the fan-in for whatever source is attached. */
  initParam(preamp.gain, dbToGain(preampDb), now());
  for (let i = 0; i < bandCount; i += 1) {
    const filter = context.createBiquadFilter();
    const params = bandParams[i] ?? { frequencyHz: EQ_BAND_FREQUENCIES_HZ[i] ?? 1000, gainDb: 0, q: GRAPHIC_BAND_Q, type: 'peaking' as const, enabled: false };
    filter.type = params.type;
    initParam(filter.frequency, params.frequencyHz, now());
    initParam(filter.Q, params.q, now());
    initParam(filter.gain, params.enabled ? params.gainDb : 0, now());
    bands.push(filter);
  }
  initParam(trim.gain, dbToGain(headroomTrimDb(preset)), now());
  initParam(limiter.threshold, LIMITER_SETTINGS.thresholdDb, now());
  initParam(limiter.knee, LIMITER_SETTINGS.knee, now());
  initParam(limiter.ratio, LIMITER_SETTINGS.ratio, now());
  initParam(limiter.attack, LIMITER_SETTINGS.attackSeconds, now());
  initParam(limiter.release, LIMITER_SETTINGS.releaseSeconds, now());
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
  initParam(output.gain, dbToGain(outputGainDb), now());
  initParam(processedIn.gain, 1, now());
  initParam(dryPath.gain, 0, now());
  initParam(limiterBypass.gain, limiterEnabled ? 0 : 1, now());

  // processedIn → preamp → (retune) → bands… → trim → { limiter, limiterBypass } → analyser → output → destination
  processedIn.connect(preamp);
  let retuneNode: WorkletNodeLike | null = null;
  let headOfEq: AudioNodeLike = preamp;
  relinkEqHead();
  const tail: AudioNodeLike = bands.length ? bands[bands.length - 1]! : preamp;
  tail.connect(trim);
  trim.connect(limiter);
  trim.connect(limiterBypass);
  limiter.connect(analyser);
  limiterBypass.connect(analyser);
  analyser.connect(output);
  output.connect(context.destination);
  dryPath.connect(output);

  function relinkEqHead(): void {
    const first: AudioNodeLike | null = bands[0] ?? null;
    if (!first) return;
    headOfEq.connect(first);
    for (let i = 0; i < bands.length - 1; i += 1) bands[i]!.connect(bands[i + 1]!);
  }

  /* ---- source ---- */
  let sourceNode: MediaElementSourceNodeLike | BufferSourceNodeLike | null = null;
  let mediaElement: RetunableMediaElement | null = null;
  let dspAvailable = false;
  let dspUnavailableReason: string | null = 'No source is attached';

  /* ---- retune ---- */
  let retuneConfig: RetuneConfig = OFF_RETUNE;
  let workletAvailable = false;
  let workletError: string | null = options.workletModuleUrl ? null : 'No worklet module URL was provided to the engine';
  let workletLoad: Promise<WorkletLoadResult> | null = null;
  let retuneApplied: RetuneApplication = 'none';
  let ratioClamped = false;

  const listeners = new Set<AudioEngineListener>();

  function notify(): void {
    if (!listeners.size) return;
    const state = getState();
    for (const listener of listeners) listener(state);
  }

  function livePreset(): EqPreset {
    return liveEqPreset(preset, preampDb, bandParams);
  }

  function currentTrimDb(): number {
    return -requiredHeadroomDb(livePreset());
  }

  function applyTrim(rampMs: number): void {
    rampParam(trim.gain, dbToGain(currentTrimDb()), now(), rampMs);
    if (bypassed) rampParam(dryPath.gain, dbToGain(matchedBypassLevelDb(livePreset(), context.sampleRate)), now(), rampMs);
  }

  function describe(): RetuneDescription {
    return describeRetune(retuneConfig);
  }

  function retuneState(): RetuneState {
    const description = describe();
    const ratio = sanitizeRatio(description.ratio);
    return {
      mode: retuneConfig.mode,
      referenceHz: retuneConfig.referenceHz,
      pitchOffsetCents: retuneConfig.pitchOffsetCents,
      totalCents: description.totalCents,
      ratio,
      ratioClamped,
      active: description.active && retuneApplied !== 'none',
      workletAvailable,
      workletError: ratioClamped ? `Requested ratio ${description.ratio.toFixed(4)} was clamped to the shifter's ${MIN_RATIO}…${MAX_RATIO} range${workletError ? `; ${workletError}` : ''}` : workletError,
      applied: retuneApplied,
      description,
    };
  }

  function getLatency(): LatencyReport {
    const baseMs = (context.baseLatency ?? 0) * 1000;
    const outputMs = context.outputLatency === undefined ? null : context.outputLatency * 1000;
    const workletMs = retuneApplied === 'worklet' ? (pitchShifterLatencySamples(context.sampleRate, defaultGrainSize(context.sampleRate)) / context.sampleRate) * 1000 : 0;
    return { baseMs, outputMs, workletMs, totalMs: baseMs + (outputMs ?? 0) + workletMs };
  }

  function getState(): AudioEngineState {
    return {
      contextState: context.state,
      dspAvailable,
      dspUnavailableReason,
      bypassed,
      presetId: preset.id,
      presetName: preset.name,
      presetModified,
      preampDb,
      outputGainDb,
      limiterEnabled,
      headroomTrimDb: currentTrimDb(),
      bypassMatchedGainDb: matchedBypassLevelDb(livePreset(), context.sampleRate),
      bandCount: bands.length,
      bands: bandParams.slice(0, bands.length).map((b) => ({ frequencyHz: b.frequencyHz, gainDb: b.gainDb, q: b.q, type: b.type, enabled: b.enabled })),
      retune: retuneState(),
      latency: getLatency(),
      disposed,
    };
  }

  function assertLive(): void {
    if (disposed) throw new Error('This audio engine has been disposed');
  }

  function connectSource(node: AudioNodeLike): void {
    node.connect(processedIn);
    node.connect(dryPath);
  }

  function attachMediaElement(element: RetunableMediaElement): AttachResult {
    assertLive();
    detach();
    if (isCrossOriginWithoutCors(element, options.pageOrigin === undefined ? currentPageOrigin() : options.pageOrigin)) {
      // Creating the source node would silence the element; leave it alone and report why.
      dspAvailable = false;
      dspUnavailableReason = `${DSP_UNAVAILABLE_REASON}: the media is served from another origin without CORS, so the browser would mute it if it entered the graph`;
      mediaElement = element;
      notify();
      return { ok: false, reason: dspUnavailableReason };
    }
    const node = context.createMediaElementSource(element);
    sourceNode = node;
    mediaElement = element;
    connectSource(node);
    dspAvailable = true;
    dspUnavailableReason = null;
    applyRetuneToElement();
    notify();
    return { ok: true, reason: null };
  }

  function attachBufferSource(node: BufferSourceNodeLike): AttachResult {
    assertLive();
    detach();
    sourceNode = node;
    mediaElement = null;
    connectSource(node);
    dspAvailable = true;
    dspUnavailableReason = null;
    notify();
    return { ok: true, reason: null };
  }

  function detach(): void {
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (mediaElement) {
      // Leave the element as we found it: normal rate, pitch preserved.
      setPlaybackRate(mediaElement, 1);
      setPreservesPitch(mediaElement, true);
      mediaElement = null;
    }
    dspAvailable = false;
    dspUnavailableReason = 'No source is attached';
    retuneApplied = retuneApplied === 'playback-rate' ? 'none' : retuneApplied;
  }

  function applyPreset(next: EqPreset, opts: { rampMs?: number } = {}): void {
    assertLive();
    const rampMs = opts.rampMs ?? rampDefault;
    preset = next;
    bandParams = presetToBandParams(next, context.sampleRate);
    preampDb = next.preampDb;
    presetModified = false;
    const t = now();
    rampParam(preamp.gain, dbToGain(preampDb), t, rampMs);
    for (let i = 0; i < bands.length; i += 1) {
      const filter = bands[i]!;
      const params = bandParams[i];
      if (!params) {
        rampParam(filter.gain, 0, t, rampMs);
        continue;
      }
      filter.type = params.type;
      glideParam(filter.frequency, params.frequencyHz, t, rampMs);
      glideParam(filter.Q, params.q, t, rampMs);
      rampParam(filter.gain, params.enabled ? params.gainDb : 0, t, rampMs);
    }
    applyTrim(rampMs);
    notify();
  }

  function setBandGain(index: number, gainDb: number, opts: { rampMs?: number } = {}): void {
    assertLive();
    const filter = bands[index];
    const params = bandParams[index];
    if (!filter || !params) throw new RangeError(`Band ${index} does not exist (bandCount ${bands.length})`);
    const rampMs = opts.rampMs ?? rampDefault;
    params.gainDb = clamp(gainDb, -12, 12);
    params.enabled = true;
    presetModified = true;
    rampParam(filter.gain, params.gainDb, now(), rampMs);
    applyTrim(rampMs);
    notify();
  }

  function setBandEnabled(index: number, enabled: boolean): void {
    assertLive();
    const filter = bands[index];
    const params = bandParams[index];
    if (!filter || !params) throw new RangeError(`Band ${index} does not exist (bandCount ${bands.length})`);
    params.enabled = enabled;
    presetModified = true;
    rampParam(filter.gain, enabled ? params.gainDb : 0, now(), rampDefault);
    applyTrim(rampDefault);
    notify();
  }

  function setPreamp(db: number, opts: { rampMs?: number } = {}): void {
    assertLive();
    const rampMs = opts.rampMs ?? rampDefault;
    preampDb = clamp(db, -12, 12);
    presetModified = true;
    rampParam(preamp.gain, dbToGain(preampDb), now(), rampMs);
    applyTrim(rampMs);
    notify();
  }

  /** Crossfade between the processed chain and a level-matched dry path (spec: bypass compares tone, not loudness). */
  function setBypass(next: boolean): void {
    assertLive();
    if (next === bypassed) return;
    bypassed = next;
    const t = now();
    const matched = dbToGain(matchedBypassLevelDb(livePreset(), context.sampleRate));
    rampParam(processedIn.gain, next ? 0 : 1, t, BYPASS_CROSSFADE_MS);
    rampParam(dryPath.gain, next ? matched : 0, t, BYPASS_CROSSFADE_MS);
    notify();
  }

  function setLimiter(enabled: boolean): void {
    assertLive();
    limiterEnabled = enabled;
    const t = now();
    rampParam(limiterBypass.gain, enabled ? 0 : 1, t, rampDefault);
    rampParam(limiter.threshold, enabled ? LIMITER_SETTINGS.thresholdDb : 0, t, rampDefault);
    notify();
  }

  function setOutputGain(db: number, opts: { rampMs?: number } = {}): void {
    assertLive();
    outputGainDb = clamp(db, -30, 0);
    rampParam(output.gain, dbToGain(outputGainDb), now(), opts.rampMs ?? rampDefault);
    notify();
  }

  /* ---- retune ---- */

  function insertRetuneNode(node: WorkletNodeLike): void {
    // preamp → node → first band (or trim when there are no bands)
    preamp.disconnect();
    retuneNode = node;
    preamp.connect(node);
    headOfEq = node;
    const first = bands[0];
    if (first) node.connect(first);
    else node.connect(trim);
  }

  function removeRetuneNode(): void {
    if (!retuneNode) return;
    preamp.disconnect();
    retuneNode.disconnect();
    retuneNode = null;
    headOfEq = preamp;
    const first = bands[0];
    if (first) preamp.connect(first);
    else preamp.connect(trim);
  }

  function setWorkletParams(ratio: number, bypass: boolean): void {
    const p = retuneNode?.parameters.get('ratio');
    const b = retuneNode?.parameters.get('bypass');
    if (p) rampParam(p, ratio, now(), rampDefault);
    if (b) b.setValueAtTime(bypass ? 1 : 0, now());
  }

  function applyRetuneToElement(): void {
    if (!mediaElement) return;
    const description = describe();
    if (retuneConfig.mode === 'linked-speed' && description.active) {
      setPreservesPitch(mediaElement, false);
      setPlaybackRate(mediaElement, sanitizeRatio(description.ratio));
    } else {
      setPlaybackRate(mediaElement, 1);
      setPreservesPitch(mediaElement, true);
    }
  }

  async function ensureWorklet(): Promise<boolean> {
    if (workletAvailable) return true;
    const url = options.workletModuleUrl;
    if (!url) {
      workletError = 'No worklet module URL was provided to the engine';
      return false;
    }
    if (!workletLoad) workletLoad = loadPitchShifterWorklet(context, url);
    let result: WorkletLoadResult;
    try {
      result = await workletLoad;
    } catch (error) {
      workletLoad = null;
      workletError = errorMessage(error);
      return false;
    }
    if (!result.ok) {
      workletLoad = null;
      workletError = result.reason;
      return false;
    }
    try {
      const node = createPitchShifterNode(context, { ratio: 1, bypass: true });
      insertRetuneNode(node);
      workletAvailable = true;
      workletError = null;
      return true;
    } catch (error) {
      workletError = errorMessage(error);
      return false;
    }
  }

  async function setRetune(config: RetuneConfig): Promise<RetuneState> {
    assertLive();
    retuneConfig = config;
    const description = describe();
    const rawRatio = description.ratio;
    ratioClamped = description.active && (rawRatio < MIN_RATIO || rawRatio > MAX_RATIO);
    const ratio = sanitizeRatio(rawRatio);

    if (!description.active || config.mode === 'off') {
      retuneApplied = 'none';
      setWorkletParams(1, true);
      applyRetuneToElement();
      notify();
      return retuneState();
    }

    if (config.mode === 'linked-speed') {
      setWorkletParams(1, true);
      if (mediaElement) {
        applyRetuneToElement();
        retuneApplied = 'playback-rate';
      } else {
        // A buffer source has its own playbackRate; the engine does not own it, so say so.
        retuneApplied = 'none';
        workletError = 'Linked speed needs a media element; attach one to change playback rate';
      }
      notify();
      return retuneState();
    }

    // preserve-tempo: the worklet is the only honest mechanism. Never silently fall back to
    // playback rate, which would change tempo the user asked to keep.
    const ready = await ensureWorklet();
    if (ready) {
      setWorkletParams(ratio, false);
      retuneApplied = 'worklet';
    } else {
      setWorkletParams(1, true);
      retuneApplied = 'none';
    }
    applyRetuneToElement();
    notify();
    return retuneState();
  }

  /* ---- misc ---- */

  function getAnalyserData(target: Uint8Array<ArrayBuffer>, kind: 'frequency' | 'time' = 'frequency'): void {
    if (kind === 'time') analyser.getByteTimeDomainData(target);
    else analyser.getByteFrequencyData(target);
  }

  function subscribe(listener: AudioEngineListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  const onStateChange = () => notify();
  context.addEventListener?.('statechange', onStateChange);

  function dispose(): void {
    if (disposed) return;
    detach();
    context.removeEventListener?.('statechange', onStateChange);
    removeRetuneNode();
    for (const node of [processedIn, dryPath, preamp, ...bands, trim, limiter, limiterBypass, analyser, output]) node.disconnect();
    listeners.clear();
    disposed = true;
  }

  return {
    context,
    attachMediaElement,
    attachBufferSource,
    detach,
    applyPreset,
    setBandGain,
    setBandEnabled,
    setPreamp,
    setBypass,
    setLimiter,
    setOutputGain,
    setRetune,
    getState,
    subscribe,
    getAnalyserData,
    getLatency,
    resume: () => context.resume(),
    suspend: () => context.suspend(),
    dispose,
  };
}

/** Frequencies the graphic profile allocates, clamped to what this sample rate can express. */
export function graphicBandFrequencies(sampleRate: number): number[] {
  const max = maxFilterFrequencyHz(sampleRate);
  return EQ_BAND_FREQUENCIES_HZ.map((f) => Math.min(f, max));
}
