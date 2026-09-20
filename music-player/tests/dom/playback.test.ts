/**
 * The two-deck engine, driven with fake media elements and the audio-core mock context: the
 * handover between decks, the crossfade point, what a skip or a pause does to a track on its way
 * out, and the fallbacks where the graph cannot carry a source.
 */
import { describe, expect, it } from 'vitest';
import { MockAudioContext, type MockAudioNode } from '@now-playing/audio-core';
import type { TrackRef } from '@now-playing/contracts';
import { PlaybackEngine, type PlaybackEvent } from '../../src/lib/playback.js';

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  private volumeValue = 1;
  get volume(): number {
    return this.volumeValue;
  }
  set volume(value: number) {
    this.volumeValue = value;
  }
  muted = false;
  preload = '';
  crossOrigin: string | null = null;
  playbackRate = 1;
  preservesPitch = true;
  error: MediaError | null = null;
  readonly buffered = { length: 0, end: () => 0 };
  /** 0 until metadata arrives, like a real element; the engine reads it to place a start point. */
  readyState = 0;
  /** How many times the element was told to fetch. A promoted preload must not add to this. */
  loadCalls = 0;
  get currentSrc(): string {
    return this.src;
  }
  getAttribute(name: string): string | null {
    return name === 'src' && this.src ? this.src : null;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {
    // As a real element does: loading starts from the top.
    this.currentTime = 0;
    this.loadCalls += 1;
  }
  async play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent(new Event('playing'));
  }
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  tick(seconds: number): void {
    this.currentTime = seconds;
    this.dispatchEvent(new Event('timeupdate'));
  }
  end(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

/** An iPhone-like element: the volume setter is silently ignored. */
class FixedVolumeAudio extends FakeAudio {
  override get volume(): number {
    return 1;
  }
  override set volume(_value: number) {
    // Ignored, as iOS does.
  }
}

function track(id: string, title: string): TrackRef {
  return { trackId: id, title, artistName: 'Fennel Grove', albumName: null, durationMs: 30_000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'local', genre: null, year: null };
}

const T1 = track('0192a7c1-2b3d-7e4f-8a9b-000000000001', 'One');
const T2 = track('0192a7c1-2b3d-7e4f-8a9b-000000000002', 'Two');
const T3 = track('0192a7c1-2b3d-7e4f-8a9b-000000000003', 'Three');

function harness(Element: typeof FakeAudio = FakeAudio) {
  const a = new Element();
  const b = new Element();
  const context = new MockAudioContext();
  const events: PlaybackEvent[] = [];
  const engine = new PlaybackEngine({
    audioElements: [a as unknown as HTMLAudioElement, b as unknown as HTMLAudioElement],
    createContext: () => context as unknown as AudioContext,
  });
  engine.onEvent((event) => events.push(event));
  const sources = () => context.nodes.filter((n) => n.kind === 'media-element-source');
  const faderOf = (source: MockAudioNode) => [...source.outputs][0] as MockAudioNode & { gain: { valueAt(t: number): number } };
  return { a, b, context, engine, events, sources, faderOf };
}

async function start(engine: PlaybackEngine, ref: TrackRef, options: { crossfadeMs?: number; processable?: boolean } = {}): Promise<void> {
  await engine.load({ track: ref, url: `blob:http://localhost:3000/${ref.title}`, processable: options.processable ?? true, ...(options.crossfadeMs !== undefined ? { crossfadeMs: options.crossfadeMs } : {}) });
  await engine.play();
}

describe('the two-deck playback engine', () => {
  it('plays on one deck and hands over to the other with a crossfade, keeping both audible until the first ends', async () => {
    const { a, b, context, engine, events, sources, faderOf } = harness();
    await start(engine, T1);
    expect(engine.getState()).toMatchObject({ status: 'playing', trackId: T1.trackId });
    expect(a.paused).toBe(false);
    expect(engine.element).toBe(a as unknown as HTMLAudioElement);

    engine.setCrossfade(2);
    a.duration = 30;
    a.tick(10);
    expect(events.filter((e) => e.type === 'crossfade-due')).toHaveLength(0);
    a.tick(28.5);
    expect(events.filter((e) => e.type === 'crossfade-due')).toEqual([{ type: 'crossfade-due', trackId: T1.trackId, positionMs: 28_500, remainingMs: 1500 }]);
    a.tick(28.7);
    expect(events.filter((e) => e.type === 'crossfade-due'), 'announced once per track').toHaveLength(1);

    const t0 = context.currentTime;
    await start(engine, T2, { crossfadeMs: 2000 });
    expect(a.paused, 'the outgoing track keeps playing').toBe(false);
    expect(b.paused).toBe(false);
    expect(engine.getState()).toMatchObject({ status: 'playing', trackId: T2.trackId });
    expect(engine.element).toBe(b as unknown as HTMLAudioElement);
    const [sourceA, sourceB] = sources();
    expect(context.reaches(sourceA!, context.destination)).toBe(true);
    expect(context.reaches(sourceB!, context.destination)).toBe(true);
    expect(faderOf(sourceA!).gain.valueAt(t0 + 2)).toBeCloseTo(0, 5);
    expect(faderOf(sourceB!).gain.valueAt(t0 + 2)).toBeCloseTo(1, 5);

    a.end();
    expect(events.filter((e) => e.type === 'outgoing-finished')).toEqual([{ type: 'outgoing-finished', trackId: T1.trackId, positionMs: 30_000, durationMs: 30_000, ended: true }]);
    expect(a.src, 'the finished deck is cleared for the track after next').toBe('');
    expect(engine.getState()).toMatchObject({ status: 'playing', trackId: T2.trackId });
  });

  it('cuts from one deck to the other when no crossfade is asked for', async () => {
    const { a, b, context, engine, events, sources } = harness();
    await start(engine, T1);
    await start(engine, T2);
    expect(a.paused).toBe(true);
    expect(a.src).toBe('');
    expect(b.paused).toBe(false);
    const [sourceA, sourceB] = sources();
    expect(context.reaches(sourceA!, context.destination)).toBe(false);
    expect(context.reaches(sourceB!, context.destination)).toBe(true);
    expect(events.filter((e) => e.type === 'outgoing-finished'), 'nothing was handed over, so nothing finishes').toHaveLength(0);
  });

  it('reports a track cut short when the next handover arrives before its fade is over', async () => {
    const { a, b, engine, events } = harness();
    await start(engine, T1);
    a.tick(20);
    await start(engine, T2, { crossfadeMs: 2000 });
    b.tick(1);
    await start(engine, T3, { crossfadeMs: 2000 });
    const finished = events.filter((e) => e.type === 'outgoing-finished');
    expect(finished).toEqual([{ type: 'outgoing-finished', trackId: T1.trackId, positionMs: 20_000, durationMs: 30_000, ended: false }]);
    expect(engine.getState().trackId).toBe(T3.trackId);
    expect(engine.element, 'the first deck is reused for the third track').toBe(a as unknown as HTMLAudioElement);
    expect(b.paused, 'the second track is now the one on its way out').toBe(false);
  });

  it('pausing during a crossfade cuts the outgoing track; resuming brings back only the chosen one', async () => {
    const { a, b, engine, events } = harness();
    await start(engine, T1);
    a.tick(20);
    await start(engine, T2, { crossfadeMs: 2000 });
    engine.pause();
    expect(events.filter((e) => e.type === 'outgoing-finished')).toEqual([{ type: 'outgoing-finished', trackId: T1.trackId, positionMs: 20_000, durationMs: 30_000, ended: false }]);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
    expect(engine.getState().status).toBe('paused');
    await engine.play();
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(true);
  });

  it('leaves short tracks alone and announces again after a seek back out of the window', async () => {
    const { a, engine, events } = harness();
    await start(engine, T1);
    engine.setCrossfade(5);
    a.duration = 8;
    a.tick(4);
    expect(events.filter((e) => e.type === 'crossfade-due'), 'shorter than two crossfades').toHaveLength(0);
    a.duration = 30;
    a.tick(27);
    expect(events.filter((e) => e.type === 'crossfade-due')).toHaveLength(1);
    engine.seek(1000);
    a.tick(26);
    expect(events.filter((e) => e.type === 'crossfade-due')).toHaveLength(2);
  });

  it('fades on the element volume where the source cannot enter the graph', async () => {
    const { a, b, engine } = harness();
    await start(engine, T1, { processable: false });
    expect(engine.getState().dspUnavailableReason).toContain('EQ unavailable');
    a.tick(20);
    await start(engine, T2, { processable: false, crossfadeMs: 400 });
    expect(b.volume, 'the incoming track starts from silence').toBe(0);
    expect(a.paused).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(b.volume).toBeGreaterThan(0);
    expect(a.volume).toBeLessThan(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(b.volume).toBeCloseTo(1, 2);
    expect(a.volume).toBeCloseTo(0, 2);
  });

  it('cuts instead of overlapping at full level where the element volume cannot be set', async () => {
    const { a, engine, events } = harness(FixedVolumeAudio);
    expect(engine.canSetVolume()).toBe(false);
    await start(engine, T1, { processable: false });
    a.tick(20);
    await start(engine, T2, { processable: false, crossfadeMs: 2000 });
    expect(a.paused).toBe(true);
    expect(events.filter((e) => e.type === 'outgoing-finished')).toEqual([{ type: 'outgoing-finished', trackId: T1.trackId, positionMs: 20_000, durationMs: 30_000, ended: false }]);
  });

  it('treats a play interrupted by a newer load as nothing to report', async () => {
    const { a, engine } = harness();
    await engine.load({ track: T1, url: 'blob:http://localhost:3000/One', processable: true });
    a.play = () => Promise.reject(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'));
    const result = await engine.play();
    expect(result).toEqual({ ok: false, reason: null });
    expect(engine.getState().error).toBeNull();
  });

  it('starts at the requested position once the track has loaded', async () => {
    const { a, engine } = harness();
    await engine.load({ track: T1, url: 'blob:http://localhost:3000/One', processable: true, startAtMs: 12_000 });
    a.dispatchEvent(new Event('loadedmetadata'));
    expect(a.currentTime).toBe(12);
  });

  it('applies the master volume and mute to both decks', async () => {
    const { a, b, engine } = harness();
    engine.setVolume(0.4);
    engine.setMuted(true);
    expect(a.volume).toBeCloseTo(0.4, 5);
    expect(b.volume).toBeCloseTo(0.4, 5);
    expect(a.muted).toBe(true);
    expect(b.muted).toBe(true);
  });
});

/**
 * Warming the idle deck before the current track ends.
 *
 * The handover used to begin at `ended`: only then was the next file looked up and handed to an
 * element that had fetched nothing, which is a real silence between two songs and not what "no gap
 * between songs from the same album" describes.
 */
describe('preloading the next track', () => {
  it('attaches the next source to the idle deck without disturbing what is playing', async () => {
    const { a, b, engine } = harness();
    await start(engine, T1);
    const playingSrc = a.src;

    expect(engine.preload({ track: T2, url: 'blob:http://localhost:3000/Two' })).toBe(true);
    expect(b.src).toBe('blob:http://localhost:3000/Two');
    expect(b.loadCalls).toBe(1);
    // The deck that is playing is untouched, and the engine still reports the track it is on.
    expect(a.src).toBe(playingSrc);
    expect(a.paused).toBe(false);
    expect(engine.getState()).toMatchObject({ status: 'playing', trackId: T1.trackId });
  });

  it('promotes the warm deck instead of fetching the track a second time', async () => {
    const { a, b, engine } = harness();
    await start(engine, T1);
    engine.preload({ track: T2, url: 'blob:http://localhost:3000/Two' });
    const fetchesBefore = b.loadCalls;

    await engine.load({ track: T2, url: 'blob:http://localhost:3000/Two' });

    // The whole point: the buffered source is reused, not thrown away and fetched again.
    expect(b.loadCalls).toBe(fetchesBefore);
    expect(b.src).toBe('blob:http://localhost:3000/Two');
    expect(engine.getState()).toMatchObject({ trackId: T2.trackId });
    expect(engine.element).toBe(b as unknown as HTMLAudioElement);
    expect(a.src).toBe('');
  });

  it('is idempotent for the same track and replaces a warm-up that is no longer next', async () => {
    const { b, engine } = harness();
    await start(engine, T1);
    expect(engine.preload({ track: T2, url: 'blob:http://localhost:3000/Two' })).toBe(true);
    expect(engine.preload({ track: T2, url: 'blob:http://localhost:3000/Two' })).toBe(true);
    // Asking twice for the same track must not refetch it.
    expect(b.loadCalls).toBe(1);

    // The queue moved on: the deck is re-warmed for whatever is next now.
    expect(engine.preload({ track: T3, url: 'blob:http://localhost:3000/Three' })).toBe(true);
    expect(b.src).toBe('blob:http://localhost:3000/Three');
  });

  it('refuses to take a deck that is still fading out, and never interrupts the crossfade', async () => {
    const { a, engine, events } = harness();
    engine.setCrossfade(2);
    await start(engine, T1);
    // A handover only happens from a deck that is actually part-way through something.
    a.duration = 30;
    a.tick(10);
    await engine.load({ track: T2, url: 'blob:http://localhost:3000/Two', crossfadeMs: 2000 });
    await engine.play();
    expect(a.paused).toBe(false);

    // T1's deck is on its way out under T2; warming it would cut the fade short.
    expect(engine.preload({ track: T3, url: 'blob:http://localhost:3000/Three' })).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(engine.getState()).toMatchObject({ trackId: T2.trackId });
  });

  it('still crossfades into a track that was warmed', async () => {
    const { a, b, engine, sources } = harness();
    engine.setCrossfade(2);
    await start(engine, T1);
    a.duration = 30;
    a.tick(10);

    engine.preload({ track: T2, url: 'blob:http://localhost:3000/Two' });
    await engine.load({ track: T2, url: 'blob:http://localhost:3000/Two', crossfadeMs: 2000 });
    await engine.play();

    // Both decks audible: the promoted deck goes through the same handover as a cold one.
    expect(a.paused).toBe(false);
    expect(b.paused).toBe(false);
    expect(sources()).toHaveLength(2);
  });

  it('declines a track with nothing to play', async () => {
    const { engine } = harness();
    await start(engine, T1);
    expect(engine.preload({ track: T2 })).toBe(false);
  });
});
