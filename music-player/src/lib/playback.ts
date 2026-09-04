/**
 * The playback engine: one `<audio>` element, one Web Audio graph, one source of truth.
 *
 * A single reused element is deliberate. Creating one per track loses the browser's decode
 * pipeline warm-up, and — more importantly — a `MediaElementSourceNode` can only ever be created
 * once per element, so a new element per track would leak a node into the graph every time.
 *
 * Everything that can fail says why: an unsupported codec, a file whose permission lapsed, a
 * cross-origin stream the EQ cannot touch. The UI shows those reasons instead of a stalled
 * progress bar.
 */
import { createAudioEngine, DSP_UNAVAILABLE_REASON, type AudioEngine, type AudioEngineState, type RetuneState } from '@now-playing/audio-core';
import type { EqPreset, RetuneConfig, TrackRef } from '@now-playing/contracts';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlaybackState {
  status: PlaybackStatus;
  trackId: string | null;
  positionMs: number;
  durationMs: number | null;
  volume: number;
  muted: boolean;
  /** Why playback is not possible, phrased for a person. */
  error: string | null;
  /** Set when audio plays but the equalizer cannot be applied to it. */
  dspUnavailableReason: string | null;
  buffered: number;
  engine: AudioEngineState | null;
}

export type PlaybackListener = (state: PlaybackState) => void;

export interface SourceRequest {
  track: TrackRef;
  /** A local file, or a URL the hub serves. Exactly one. */
  file?: File | null;
  url?: string | null;
  /** True when the URL is same-origin or CORS-enabled, so the graph may process it. */
  processable?: boolean;
  startAtMs?: number;
}

export interface PlaybackEngineOptions {
  workletModuleUrl?: string | null;
  /** Injected in tests; the real one comes from the browser. */
  audioElement?: HTMLAudioElement;
  createContext?: () => AudioContext;
  onEvent?: (event: { type: 'started' | 'ended' | 'error' | 'seek'; trackId: string | null; positionMs: number; reason?: string }) => void;
}

const VOLUME_KEY = 'np.player.volume';

export class PlaybackEngine {
  private readonly audio: HTMLAudioElement;
  private context: AudioContext | null = null;
  private engine: AudioEngine | null = null;
  private objectUrl: string | null = null;
  private readonly listeners = new Set<PlaybackListener>();
  private state: PlaybackState = {
    status: 'idle',
    trackId: null,
    positionMs: 0,
    durationMs: null,
    volume: 1,
    muted: false,
    error: null,
    dspUnavailableReason: null,
    buffered: 0,
    engine: null,
  };

  constructor(private readonly options: PlaybackEngineOptions = {}) {
    this.audio = options.audioElement ?? new Audio();
    this.audio.preload = 'metadata';
    this.audio.crossOrigin = 'anonymous';
    this.restoreVolume();
    this.bindElement();
  }

  /* ------------------------------------------------------------------ state */

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): PlaybackState {
    return this.state;
  }

  private update(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private restoreVolume(): void {
    try {
      const stored = window.localStorage.getItem(VOLUME_KEY);
      if (stored !== null) {
        const volume = Math.min(1, Math.max(0, Number(stored)));
        if (Number.isFinite(volume)) {
          this.audio.volume = volume;
          this.state = { ...this.state, volume };
        }
      }
    } catch {
      // Storage blocked: the default volume is fine.
    }
  }

  private bindElement(): void {
    const audio = this.audio;
    audio.addEventListener('loadedmetadata', () => this.update({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null }));
    audio.addEventListener('timeupdate', () => this.update({ positionMs: Math.round(audio.currentTime * 1000) }));
    audio.addEventListener('progress', () => {
      const end = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
      this.update({ buffered: audio.duration > 0 ? end / audio.duration : 0 });
    });
    audio.addEventListener('playing', () => this.update({ status: 'playing', error: null }));
    audio.addEventListener('pause', () => {
      if (this.state.status !== 'ended') this.update({ status: 'paused' });
    });
    audio.addEventListener('waiting', () => this.update({ status: 'loading' }));
    audio.addEventListener('ended', () => {
      this.update({ status: 'ended', positionMs: this.state.durationMs ?? this.state.positionMs });
      this.options.onEvent?.({ type: 'ended', trackId: this.state.trackId, positionMs: this.state.positionMs });
    });
    audio.addEventListener('error', () => {
      const reason = describeMediaError(audio.error, this.state.trackId);
      this.update({ status: 'error', error: reason });
      this.options.onEvent?.({ type: 'error', trackId: this.state.trackId, positionMs: this.state.positionMs, reason });
    });
  }

  /* ------------------------------------------------------------- audio graph */

  /**
   * The AudioContext is created on the first user gesture, not at startup: browsers suspend a
   * context created without one, and a suspended context makes the first play silently fail.
   */
  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    try {
      const Ctor = this.options.createContext ?? (() => new AudioContext({ latencyHint: 'playback' }));
      this.context = Ctor();
      return this.context;
    } catch {
      return null;
    }
  }

  private ensureEngine(): AudioEngine | null {
    if (this.engine) return this.engine;
    const context = this.ensureContext();
    if (!context) return null;
    this.engine = createAudioEngine(context as unknown as Parameters<typeof createAudioEngine>[0], {
      workletModuleUrl: this.options.workletModuleUrl ?? null,
      pageOrigin: typeof window === 'undefined' ? null : window.location.origin,
    });
    this.engine.subscribe((engineState) => this.update({ engine: engineState }));
    return this.engine;
  }

  /** Attach the element to the graph. Returns the reason when the EQ cannot be applied. */
  private connectGraph(processable: boolean): string | null {
    if (!processable) return DSP_UNAVAILABLE_REASON;
    const engine = this.ensureEngine();
    if (!engine) return 'This browser did not allow an audio processing context, so the equalizer is unavailable.';
    const result = engine.attachMediaElement(this.audio as unknown as Parameters<AudioEngine['attachMediaElement']>[0]);
    return result.ok ? null : result.reason;
  }

  /* --------------------------------------------------------------- transport */

  async load(request: SourceRequest): Promise<void> {
    this.revokeObjectUrl();
    this.update({ status: 'loading', trackId: request.track.trackId, positionMs: 0, durationMs: request.track.durationMs, error: null, buffered: 0 });

    let src: string;
    let processable: boolean;
    if (request.file) {
      // A blob URL is same-origin by definition, so local files always reach the equalizer.
      this.objectUrl = URL.createObjectURL(request.file);
      src = this.objectUrl;
      processable = true;
    } else if (request.url) {
      src = request.url;
      processable = request.processable ?? isSameOrigin(request.url);
    } else {
      this.update({ status: 'error', error: 'That track has no playable file on this device.' });
      return;
    }

    this.audio.src = src;
    const dspUnavailableReason = this.connectGraph(processable);
    this.update({ dspUnavailableReason });
    if (request.startAtMs) this.audio.currentTime = request.startAtMs / 1000;
    this.audio.load();
  }

  async play(): Promise<{ ok: boolean; reason: string | null }> {
    const context = this.ensureContext();
    if (context?.state === 'suspended') await context.resume().catch(() => undefined);
    try {
      await this.audio.play();
      this.options.onEvent?.({ type: 'started', trackId: this.state.trackId, positionMs: this.state.positionMs });
      return { ok: true, reason: null };
    } catch (err) {
      // Autoplay refusal is the common case and is not an error worth alarming about.
      const reason = err instanceof Error && err.name === 'NotAllowedError' ? 'Your browser needs a tap or click before it will start audio.' : err instanceof Error ? err.message : String(err);
      this.update({ status: 'paused', error: reason });
      return { ok: false, reason };
    }
  }

  pause(): void {
    this.audio.pause();
  }

  async toggle(): Promise<void> {
    if (this.state.status === 'playing') this.pause();
    else await this.play();
  }

  seek(positionMs: number): void {
    const clamped = Math.max(0, this.state.durationMs === null ? positionMs : Math.min(positionMs, this.state.durationMs));
    this.audio.currentTime = clamped / 1000;
    this.update({ positionMs: clamped });
    this.options.onEvent?.({ type: 'seek', trackId: this.state.trackId, positionMs: clamped });
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    this.audio.volume = clamped;
    this.update({ volume: clamped });
    try {
      window.localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      // Not persisting a volume is a small loss; failing to set it would not be.
    }
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted;
    this.update({ muted });
  }

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.revokeObjectUrl();
    this.update({ status: 'idle', trackId: null, positionMs: 0, durationMs: null, error: null });
  }

  /* ----------------------------------------------------------------- effects */

  applyPreset(preset: EqPreset): void {
    this.ensureEngine()?.applyPreset(preset);
  }

  setBandGain(index: number, gainDb: number): void {
    this.ensureEngine()?.setBandGain(index, gainDb);
  }

  setPreamp(db: number): void {
    this.ensureEngine()?.setPreamp(db);
  }

  setBypass(bypassed: boolean): void {
    this.ensureEngine()?.setBypass(bypassed);
  }

  setLimiter(enabled: boolean): void {
    this.ensureEngine()?.setLimiter(enabled);
  }

  async setRetune(config: RetuneConfig): Promise<RetuneState | null> {
    const engine = this.ensureEngine();
    return engine ? engine.setRetune(config) : null;
  }

  analyser(target: Uint8Array<ArrayBuffer>, kind: 'frequency' | 'time' = 'frequency'): void {
    this.engine?.getAnalyserData(target, kind);
  }

  latency(): { totalMs: number } | null {
    const report = this.engine?.getLatency();
    return report ? { totalMs: report.totalMs } : null;
  }

  get element(): HTMLAudioElement {
    return this.audio;
  }

  dispose(): void {
    this.stop();
    this.engine?.dispose();
    this.engine = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.listeners.clear();
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Media errors are numeric codes; a listener needs a sentence. */
export function describeMediaError(error: MediaError | null, trackId: string | null): string {
  void trackId;
  if (!error) return 'That track could not be played.';
  switch (error.code) {
    case 1:
      return 'Loading was stopped before the track could play.';
    case 2:
      return 'The file could not be read. If it is on a removable drive or a network share, check that it is still connected.';
    case 3:
      return 'The file is damaged, or its audio is encoded in a way this browser cannot decode.';
    case 4:
      return 'This browser cannot play this format. The file is fine — the browser has no decoder for it.';
    default:
      return error.message || 'That track could not be played.';
  }
}
