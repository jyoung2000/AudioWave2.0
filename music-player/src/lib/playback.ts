/**
 * The playback engine: two `<audio>` elements, one Web Audio graph, one source of truth.
 *
 * Two elements — decks, as a DJ would call them — because a crossfade needs the outgoing track to
 * keep playing while the incoming one starts. Each deck is bound to the graph once and then reused
 * for every track it plays (a `MediaElementSourceNode` can only ever be created once per element),
 * and the engine alternates between the two so that whatever is playing can always hand over to
 * the other. With crossfade off, the handover is a plain cut, exactly as one element would do it.
 *
 * The fades themselves run in the audio graph where the source can enter it, and on the elements'
 * own volume where it cannot (a cross-origin stream). On a platform that fixes the element volume,
 * that second path is not available, and the engine cuts rather than overlapping two tracks at
 * full level.
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

export type PlaybackEvent =
  | { type: 'started' | 'error' | 'seek'; trackId: string | null; positionMs: number; reason?: string }
  | { type: 'ended'; trackId: string | null; positionMs: number }
  /** The playing track is within one crossfade of its end: whoever owns the queue should start the next one now. */
  | { type: 'crossfade-due'; trackId: string; positionMs: number; remainingMs: number }
  /** A track handed over by a crossfade has finished — or was cut short by the next handover. */
  | { type: 'outgoing-finished'; trackId: string; positionMs: number; durationMs: number | null; ended: boolean };

export type PlaybackEventListener = (event: PlaybackEvent) => void;

export interface SourceRequest {
  track: TrackRef;
  /** A local file, or a URL the hub serves. Exactly one. */
  file?: File | null;
  url?: string | null;
  /** True when the URL is same-origin or CORS-enabled, so the graph may process it. */
  processable?: boolean;
  startAtMs?: number;
  /** Fade the track now playing out over this long while this one fades in. Absent or 0: cut. */
  crossfadeMs?: number;
}

export interface PlaybackEngineOptions {
  workletModuleUrl?: string | null;
  /** Injected in tests; the real ones come from the browser. Two, so one can fade out under the other. */
  audioElements?: [HTMLAudioElement, HTMLAudioElement];
  createContext?: () => AudioContext;
  onEvent?: PlaybackEventListener;
}

/** The longest crossfade offered, in seconds: iTunes stopped at twelve, and so does this. */
export const MAX_CROSSFADE_SECONDS = 12;

const VOLUME_KEY = 'np.player.volume';

/** How long `play()` waits for a suspended AudioContext before starting the element anyway. */
const RESUME_WAIT_MS = 300;

/** Element-volume fade step. A timer, not an animation frame: frames stop while the page is hidden. */
const FADE_STEP_MS = 16;

type DeckRole = 'idle' | 'active' | 'outgoing';

interface Deck {
  readonly audio: HTMLAudioElement;
  role: DeckRole;
  trackId: string | null;
  durationMs: number | null;
  objectUrl: string | null;
  /** Fade multiplier on the element's own volume, for sources the graph cannot fade. */
  gain: number;
  fadeFrame: ReturnType<typeof setTimeout> | null;
  /** Whether this deck's element is currently a source in the graph. */
  inGraph: boolean;
  /** Set once the crossfade point has been announced for the loaded track. */
  dueSignalled: boolean;
  /** Attaching to the graph happens when playback starts, so a crossfade begins with the sound. */
  pendingAttach: { processable: boolean; crossfadeMs: number } | null;
  /**
   * A track whose source is already attached to this idle deck and buffering.
   *
   * `trackId` stays null while this is set: the deck is warm, not loaded, and nothing else should
   * treat it as playing. `load()` promotes it instead of fetching the source again.
   */
  preloaded: { trackId: string; processable: boolean } | null;
}

export class PlaybackEngine {
  private readonly decks: [Deck, Deck];
  private active = 0;
  private context: AudioContext | null = null;
  private engine: AudioEngine | null = null;
  private crossfadeSeconds = 0;
  private master = 1;
  private muted = false;
  private readonly volumeControllable: boolean;
  private readonly listeners = new Set<PlaybackListener>();
  private readonly eventListeners = new Set<PlaybackEventListener>();
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
    const elements = options.audioElements ?? [new Audio(), new Audio()];
    this.decks = [this.makeDeck(elements[0]), this.makeDeck(elements[1])];
    this.volumeControllable = probeVolumeControl(elements[0]);
    this.restoreVolume();
    for (const deck of this.decks) {
      this.applyVolume(deck);
      this.bindDeck(deck);
    }
    requestPlaybackAudioSession();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.recoverContext();
      });
    }
  }

  /* ------------------------------------------------------------------ state */

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Transport events the queue owner needs: track ends, crossfade points, handovers finishing. */
  onEvent(listener: PlaybackEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  getState(): PlaybackState {
    return this.state;
  }

  private update(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private emit(event: PlaybackEvent): void {
    this.options.onEvent?.(event);
    for (const listener of this.eventListeners) listener(event);
  }

  private restoreVolume(): void {
    try {
      const stored = window.localStorage.getItem(VOLUME_KEY);
      if (stored !== null) {
        const volume = Math.min(1, Math.max(0, Number(stored)));
        if (Number.isFinite(volume)) {
          this.master = volume;
          this.state = { ...this.state, volume };
        }
      }
    } catch {
      // Storage blocked: the default volume is fine.
    }
  }

  /* ------------------------------------------------------------------ decks */

  private makeDeck(audio: HTMLAudioElement): Deck {
    audio.preload = 'auto';
    return { audio, role: 'idle', trackId: null, durationMs: null, objectUrl: null, gain: 1, fadeFrame: null, inGraph: false, dueSignalled: false, pendingAttach: null, preloaded: null };
  }

  private get activeDeck(): Deck {
    return this.decks[this.active]!;
  }

  private get otherDeck(): Deck {
    return this.decks[1 - this.active]!;
  }

  private bindDeck(deck: Deck): void {
    const audio = deck.audio;
    const isActive = () => deck.role === 'active';
    audio.addEventListener('loadedmetadata', () => {
      deck.durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null;
      if (isActive()) this.update({ durationMs: deck.durationMs });
    });
    audio.addEventListener('timeupdate', () => {
      if (!isActive()) return;
      this.update({ positionMs: Math.round(audio.currentTime * 1000) });
      this.maybeAnnounceCrossfade(deck);
    });
    audio.addEventListener('progress', () => {
      if (!isActive()) return;
      const end = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
      this.update({ buffered: audio.duration > 0 ? end / audio.duration : 0 });
    });
    audio.addEventListener('playing', () => {
      if (isActive()) this.update({ status: 'playing', error: null });
    });
    audio.addEventListener('pause', () => {
      if (isActive() && this.state.status !== 'ended') this.update({ status: 'paused' });
    });
    audio.addEventListener('waiting', () => {
      if (isActive()) this.update({ status: 'loading' });
    });
    audio.addEventListener('ended', () => {
      if (deck.role === 'outgoing') {
        this.finishOutgoing(deck, true);
        return;
      }
      if (!isActive()) return;
      this.update({ status: 'ended', positionMs: this.state.durationMs ?? this.state.positionMs });
      this.emit({ type: 'ended', trackId: this.state.trackId, positionMs: this.state.positionMs });
    });
    audio.addEventListener('error', () => {
      if (deck.role === 'outgoing') {
        this.finishOutgoing(deck, false);
        return;
      }
      if (!isActive()) return;
      const reason = describeMediaError(audio.error, this.state.trackId);
      this.update({ status: 'error', error: reason });
      this.emit({ type: 'error', trackId: this.state.trackId, positionMs: this.state.positionMs, reason });
    });
  }

  /**
   * Announce the crossfade point once per track: when less than one crossfade remains. Tracks
   * shorter than two crossfades are left alone, or a short interlude would start the next song
   * before it had properly begun itself.
   */
  private maybeAnnounceCrossfade(deck: Deck): void {
    if (this.crossfadeSeconds <= 0 || deck.dueSignalled || deck.audio.paused || !deck.trackId) return;
    const duration = deck.audio.duration;
    if (!Number.isFinite(duration) || duration <= this.crossfadeSeconds * 2) return;
    const position = deck.audio.currentTime;
    const remaining = duration - position;
    if (position > 0 && remaining <= this.crossfadeSeconds) {
      deck.dueSignalled = true;
      this.emit({ type: 'crossfade-due', trackId: deck.trackId, positionMs: Math.round(position * 1000), remainingMs: Math.round(remaining * 1000) });
    }
  }

  /** An outgoing deck is done: report how it went, then clear it for the track after next. */
  private finishOutgoing(deck: Deck, ended: boolean): void {
    const trackId = deck.trackId;
    const positionMs = ended ? (deck.durationMs ?? Math.round(deck.audio.currentTime * 1000)) : Math.round(deck.audio.currentTime * 1000);
    const durationMs = deck.durationMs;
    this.resetDeck(deck);
    if (trackId) this.emit({ type: 'outgoing-finished', trackId, positionMs, durationMs, ended });
  }

  /** Silence a deck and release everything it held. Its role is cleared first so its events are ignored. */
  private resetDeck(deck: Deck): void {
    deck.role = 'idle';
    this.cancelDeckFade(deck);
    deck.audio.pause();
    if (deck.audio.getAttribute('src') !== null) {
      deck.audio.removeAttribute('src');
      deck.audio.load();
    }
    if (deck.objectUrl) {
      URL.revokeObjectURL(deck.objectUrl);
      deck.objectUrl = null;
    }
    deck.trackId = null;
    deck.durationMs = null;
    deck.dueSignalled = false;
    deck.pendingAttach = null;
    deck.preloaded = null;
    deck.inGraph = false;
    deck.gain = 1;
    this.applyVolume(deck);
  }

  private applyVolume(deck: Deck): void {
    deck.audio.volume = this.master * deck.gain;
    deck.audio.muted = this.muted;
  }

  private cancelDeckFade(deck: Deck): void {
    if (deck.fadeFrame !== null) {
      clearTimeout(deck.fadeFrame);
      deck.fadeFrame = null;
    }
  }

  /** Equal-power fade on the element's own volume, for a source the graph cannot fade. */
  private fadeDeckGain(deck: Deck, to: number, durationMs: number): void {
    this.cancelDeckFade(deck);
    if (!this.volumeControllable || durationMs <= 0) {
      deck.gain = to;
      this.applyVolume(deck);
      return;
    }
    const from = deck.gain;
    const started = nowMs();
    const step = (): void => {
      const x = Math.min(1, (nowMs() - started) / durationMs);
      deck.gain = to > from ? from + (to - from) * Math.sin((x * Math.PI) / 2) : to + (from - to) * Math.cos((x * Math.PI) / 2);
      this.applyVolume(deck);
      deck.fadeFrame = x < 1 ? setTimeout(step, FADE_STEP_MS) : null;
    };
    deck.fadeFrame = setTimeout(step, FADE_STEP_MS);
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

  /**
   * A phone call, Siri or another app can take the audio output away; browsers report that as a
   * context that is no longer running. When the page is back in front and we believe we are
   * playing, ask for it back.
   */
  private async recoverContext(): Promise<void> {
    const context = this.context;
    if (!context || this.state.status !== 'playing') return;
    if ((context.state as string) !== 'running') await context.resume().catch(() => undefined);
  }

  /** Attach the deck's element to the graph. Returns the reason when the EQ cannot be applied. */
  private connectGraph(deck: Deck, processable: boolean, crossfadeMs: number): string | null {
    if (!processable) {
      // The incoming source stays outside the graph; the outgoing one still leaves gracefully.
      if (crossfadeMs > 0) this.engine?.fadeOutPrimary(crossfadeMs);
      else this.engine?.detach();
      deck.inGraph = false;
      return DSP_UNAVAILABLE_REASON;
    }
    const engine = this.ensureEngine();
    if (!engine) {
      deck.inGraph = false;
      return 'This browser did not allow an audio processing context, so the equalizer is unavailable.';
    }
    const result = engine.attachMediaElement(deck.audio as unknown as Parameters<AudioEngine['attachMediaElement']>[0], { crossfadeMs });
    deck.inGraph = result.ok;
    return result.ok ? null : result.reason;
  }

  /**
   * Where the graph does not carry a deck, its element volume does the fading. If the volume
   * cannot be set at all, the outgoing track is cut instead of playing on at full level.
   */
  private fadeOutsideGraph(incoming: Deck, crossfadeMs: number): void {
    const outgoing = this.otherDeck;
    if (crossfadeMs <= 0) return;
    if (!this.volumeControllable) {
      if (outgoing.role === 'outgoing' && !outgoing.inGraph) this.finishOutgoing(outgoing, false);
      if (!incoming.inGraph) {
        incoming.gain = 1;
        this.applyVolume(incoming);
      }
      return;
    }
    if (outgoing.role === 'outgoing' && !outgoing.inGraph) this.fadeDeckGain(outgoing, 0, crossfadeMs);
    if (!incoming.inGraph) {
      incoming.gain = 0;
      this.applyVolume(incoming);
      this.fadeDeckGain(incoming, 1, crossfadeMs);
    }
  }

  /* --------------------------------------------------------------- transport */

  /**
   * Warm the idle deck with the track that is coming next.
   *
   * Handing over between two tracks used to begin at the `ended` event: only then was the next
   * file looked up and handed to an element that had fetched nothing. Between one song and the
   * next that is a silence of however long the lookup and the first buffer take, which is not what
   * "no gap between songs from the same album" describes.
   *
   * So the source is attached to the other deck early and left to buffer, and `load()` promotes
   * that deck instead of fetching again. Safe to call repeatedly: a deck that is busy, or already
   * warm for this track, is left alone.
   *
   * Returns whether the deck is now warm for this track.
   */
  preload(request: { track: TrackRef; file?: File | null; url?: string | null; processable?: boolean }): boolean {
    const deck = this.otherDeck;
    // Still fading out under the current track, or somehow in use: not ours to take.
    if (deck.role !== 'idle') return false;
    if (deck.preloaded?.trackId === request.track.trackId) return true;
    // A stale warm-up for a track that is no longer next; its object URL is revoked here.
    if (deck.preloaded) this.resetDeck(deck);

    let src: string;
    let processable: boolean;
    let objectUrl: string | null = null;
    if (request.file) {
      objectUrl = URL.createObjectURL(request.file);
      src = objectUrl;
      processable = true;
    } else if (request.url) {
      src = request.url;
      processable = request.processable ?? isSameOrigin(request.url);
    } else {
      return false;
    }

    deck.objectUrl = objectUrl;
    deck.audio.crossOrigin = processable && !objectUrl ? 'anonymous' : null;
    deck.audio.src = src;
    deck.audio.load();
    deck.preloaded = { trackId: request.track.trackId, processable };
    return true;
  }

  async load(request: SourceRequest): Promise<void> {
    const crossfadeMs = Math.max(0, Math.min(MAX_CROSSFADE_SECONDS * 1000, request.crossfadeMs ?? 0));
    const current = this.activeDeck;
    // An empty active deck takes the track itself; an occupied one hands over to the other deck,
    // with a fade when there is something audible to fade from.
    const switching = current.trackId !== null;
    const next = switching ? this.otherDeck : current;
    // `preload()` may already have attached this very track to that deck and left it buffering.
    // Promoting it is the whole point: re-assigning `src` would throw the buffer away and put the
    // gap back. Only when switching — a preload always lives on the deck that is *not* active.
    const warm = switching && next.role === 'idle' && next.preloaded?.trackId === request.track.trackId;

    let src = '';
    let processable: boolean;
    let objectUrl: string | null = null;
    if (warm) {
      processable = next.preloaded!.processable;
      // The deck already owns the object URL it created; creating a second one would leak it.
      objectUrl = next.objectUrl;
    } else if (request.file) {
      // A blob URL is same-origin by definition, so local files always reach the equalizer.
      objectUrl = URL.createObjectURL(request.file);
      src = objectUrl;
      processable = true;
    } else if (request.url) {
      src = request.url;
      processable = request.processable ?? isSameOrigin(request.url);
    } else {
      this.update({ status: 'error', error: 'That track has no playable file on this device.' });
      return;
    }

    let handover = false;
    if (switching) {
      // The other deck may still be on its way out from the previous handover; this one cuts it.
      if (next.role === 'outgoing') this.finishOutgoing(next, false);
      // Resetting a warm deck would remove the very source it was warmed with.
      if (!warm) this.resetDeck(next);
      handover = crossfadeMs > 0 && current.role === 'active' && !current.audio.paused && current.audio.currentTime > 0;
      if (handover) {
        current.role = 'outgoing';
        current.dueSignalled = true;
      } else {
        this.resetDeck(current);
      }
      this.active = 1 - this.active;
    } else {
      this.resetDeck(next);
    }
    next.role = 'active';
    next.trackId = request.track.trackId;
    next.durationMs = request.track.durationMs;
    next.objectUrl = objectUrl;
    next.preloaded = null;
    next.dueSignalled = false;
    next.pendingAttach = { processable, crossfadeMs: handover ? crossfadeMs : 0 };
    this.update({ status: 'loading', trackId: request.track.trackId, positionMs: 0, durationMs: request.track.durationMs, error: null, buffered: 0 });
    if (!warm) {
      // A CORS request is only worth making for a source the graph will process; asking for one from
      // a server that does not answer CORS would stop the track from loading at all.
      next.audio.crossOrigin = processable && !objectUrl ? 'anonymous' : null;
      next.audio.src = src;
      next.audio.load();
    }
    // `load()` resets the position, so a start point has to wait until the metadata is in — unless
    // the deck was warmed earlier and already has it, in which case `loadedmetadata` has been and
    // gone and waiting for it again would mean waiting for ever.
    const startAtMs = request.startAtMs;
    if (startAtMs) {
      const audio = next.audio;
      const trackId = request.track.trackId;
      if (audio.readyState >= 1) {
        audio.currentTime = startAtMs / 1000;
      } else {
        audio.addEventListener(
          'loadedmetadata',
          () => {
            if (next.trackId === trackId) audio.currentTime = startAtMs / 1000;
          },
          { once: true },
        );
      }
    }
  }

  async play(): Promise<{ ok: boolean; reason: string | null }> {
    const context = this.ensureContext();
    if (context && (context.state as string) !== 'running') {
      // iOS can leave an 'interrupted' context whose resume never settles; the element may still play.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        context.resume().catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESUME_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    const deck = this.activeDeck;
    if (deck.pendingAttach) {
      const { processable, crossfadeMs } = deck.pendingAttach;
      deck.pendingAttach = null;
      // Attaching now, not at load, so the fades start with the sound rather than before it.
      const dspUnavailableReason = this.connectGraph(deck, processable, crossfadeMs);
      this.update({ dspUnavailableReason });
      this.fadeOutsideGraph(deck, crossfadeMs);
    }
    try {
      await deck.audio.play();
      this.emit({ type: 'started', trackId: this.state.trackId, positionMs: this.state.positionMs });
      return { ok: true, reason: null };
    } catch (err) {
      // A newer load or a pause interrupted this play; whatever replaced it reports for itself.
      if (err instanceof Error && err.name === 'AbortError') return { ok: false, reason: null };
      // Autoplay refusal is the common case and is not an error worth alarming about.
      const reason = err instanceof Error && err.name === 'NotAllowedError' ? 'Your browser needs a tap or click before it will start audio.' : err instanceof Error ? err.message : String(err);
      this.update({ status: 'paused', error: reason });
      return { ok: false, reason };
    }
  }

  pause(): void {
    // Pausing mid-crossfade cuts the track on its way out; resuming brings back only the one you chose.
    const outgoing = this.otherDeck;
    if (outgoing.role === 'outgoing') this.finishOutgoing(outgoing, false);
    this.activeDeck.audio.pause();
  }

  async toggle(): Promise<void> {
    if (this.state.status === 'playing') this.pause();
    else await this.play();
  }

  seek(positionMs: number): void {
    const deck = this.activeDeck;
    const clamped = Math.max(0, this.state.durationMs === null ? positionMs : Math.min(positionMs, this.state.durationMs));
    deck.audio.currentTime = clamped / 1000;
    // Seeking back out of the crossfade window lets the point be announced again.
    deck.dueSignalled = false;
    this.update({ positionMs: clamped });
    this.emit({ type: 'seek', trackId: this.state.trackId, positionMs: clamped });
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    this.master = clamped;
    for (const deck of this.decks) this.applyVolume(deck);
    this.update({ volume: clamped });
    try {
      window.localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      // Not persisting a volume is a small loss; failing to set it would not be.
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const deck of this.decks) this.applyVolume(deck);
    this.update({ muted });
  }

  /** Seconds of overlap between one track and the next. 0 turns crossfading off. */
  setCrossfade(seconds: number): void {
    this.crossfadeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.min(MAX_CROSSFADE_SECONDS, seconds)) : 0;
    // A longer window may already have been entered; a shorter one may have been passed. Let the next tick decide.
    this.activeDeck.dueSignalled = false;
  }

  /** Whether this browser lets the page set the element volume at all; iPhones do not. */
  canSetVolume(): boolean {
    return this.volumeControllable;
  }

  stop(): void {
    const outgoing = this.otherDeck;
    if (outgoing.role === 'outgoing') this.finishOutgoing(outgoing, false);
    this.resetDeck(this.activeDeck);
    this.resetDeck(outgoing);
    this.engine?.detach();
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

  /** The element carrying the current track. */
  get element(): HTMLAudioElement {
    return this.activeDeck.audio;
  }

  dispose(): void {
    this.stop();
    this.engine?.dispose();
    this.engine = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.listeners.clear();
    this.eventListeners.clear();
  }
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Whether the page may set an element's volume. iOS ignores the setter and keeps reporting 1, which
 * is what this detects; on such a platform a fade has to happen in the graph or not at all.
 */
function probeVolumeControl(audio: HTMLAudioElement): boolean {
  try {
    const before = audio.volume;
    audio.volume = 0.5;
    const controllable = Math.abs(audio.volume - 0.5) < 0.01;
    audio.volume = before;
    return controllable;
  } catch {
    return false;
  }
}

/**
 * Ask the platform to treat this page as a music player. Where the Audio Session API exists
 * (Safari on iOS 17 and later), this is what keeps processed audio going when the screen locks
 * and stops the silent switch from muting it. Elsewhere it is a no-op.
 */
export function requestPlaybackAudioSession(): boolean {
  if (typeof navigator === 'undefined') return false;
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session) return false;
  try {
    session.type = 'playback';
    return true;
  } catch {
    return false;
  }
}

/** Whether the Audio Session API is present, for the capability report. */
export function audioSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'audioSession' in navigator;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
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
