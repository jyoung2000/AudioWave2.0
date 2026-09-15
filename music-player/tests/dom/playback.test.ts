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
  get currentSrc(): string {
    return this.src;
  }
  getAttribute(name: string): string | null {
    return name === 'src' && this.src ? this.src : null;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  load(): void {}
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
