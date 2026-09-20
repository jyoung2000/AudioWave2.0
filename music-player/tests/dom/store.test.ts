/**
 * The store driving the real two-deck engine: what happens when a track ends, when loads overlap,
 * and when the entry that is playing is taken out of the queue. Files are resolved by a stand-in so
 * each test can decide how long finding one takes.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAudioContext } from '@now-playing/audio-core';
import type { TrackRef } from '@now-playing/contracts';
import { openPlayerDb, resetPlayerDbForTests } from '../../src/lib/db.js';
import type * as LibraryModule from '../../src/lib/library.js';
import { PlaybackEngine } from '../../src/lib/playback.js';
import { PlayerStore, type QueueEntry } from '../../src/state/store.js';

const { delays } = vi.hoisted(() => ({ delays: new Map<string, number>() }));

vi.mock('../../src/lib/library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LibraryModule>();
  return {
    ...actual,
    resolveFile: async (_db: unknown, trackId: string) => {
      const delay = delays.get(trackId) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return { file: new File(['audio'], `${trackId}.mp3`, { type: 'audio/mpeg' }) };
    },
  };
});

class FakeAudio extends EventTarget {
  src = '';
  currentTime = 0;
  duration = 30;
  paused = true;
  volume = 1;
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
  end(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.dispatchEvent(new Event('ended'));
  }
}

function track(n: number): TrackRef {
  return { trackId: `0192a7c1-2b3d-7e4f-8a9b-00000000000${n}`, title: `Track ${n}`, artistName: 'Fennel Grove', albumName: null, durationMs: 30_000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'local', genre: null, year: null };
}

const entries: QueueEntry[] = [1, 2, 3].map((n) => ({ id: `entry-${n}`, track: track(n), context: { kind: 'library', id: null, name: null } }));

let counter = 0;

async function setup() {
  resetPlayerDbForTests();
  counter += 1;
  const db = await openPlayerDb(`now-playing-store-test-${counter}`);
  const a = new FakeAudio();
  const b = new FakeAudio();
  const context = new MockAudioContext();
  const engine = new PlaybackEngine({ audioElements: [a as unknown as HTMLAudioElement, b as unknown as HTMLAudioElement], createContext: () => context as unknown as AudioContext });
  const store = new PlayerStore(engine);
  await store.init(db);
  const active = (): FakeAudio => engine.element as unknown as FakeAudio;
  const events = (type: string) => store.getSnapshot().events.filter((e) => e.type === type);
  return { store, engine, active, events };
}

async function playingTrack(engine: PlaybackEngine, trackId: string): Promise<void> {
  await vi.waitFor(() => expect(engine.getState()).toMatchObject({ status: 'playing', trackId }));
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  delays.clear();
  // Nothing in these tests should reach a helper or a hub.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the end of a track', () => {
  it('with repeat-one restarts the track once instead of looping on its own updates', async () => {
    const { store, engine, active, events } = await setup();
    await store.setRepeat('one');
    store.setQueue(entries, 0);
    await playingTrack(engine, entries[0]!.track.trackId);

    active().end();
    await playingTrack(engine, entries[0]!.track.trackId);
    await settle();
    expect(events('completed')).toHaveLength(1);
    expect(store.getSnapshot().queueIndex).toBe(0);
  });

  it('moves on exactly one track, however many updates follow the end', async () => {
    const { store, engine, active, events } = await setup();
    store.setQueue(entries, 0);
    await playingTrack(engine, entries[0]!.track.trackId);

    const deck = active();
    deck.end();
    // A late timeupdate while the status still reads "ended" must not count as a second end.
    deck.dispatchEvent(new Event('timeupdate'));
    deck.dispatchEvent(new Event('timeupdate'));
    await playingTrack(engine, entries[1]!.track.trackId);
    await settle();
    expect(store.getSnapshot().queueIndex).toBe(1);
    expect(events('completed')).toHaveLength(1);
  });
});

describe('overlapping loads', () => {
  it('the most recent request wins even when an older one resolves later', async () => {
    const { store, engine } = await setup();
    store.setQueue(entries, 0);
    await playingTrack(engine, entries[0]!.track.trackId);

    delays.set(entries[1]!.track.trackId, 40);
    void store.jumpTo(1);
    void store.jumpTo(2);
    await playingTrack(engine, entries[2]!.track.trackId);
    await settle(120);
    expect(engine.getState().trackId).toBe(entries[2]!.track.trackId);
    expect(store.getSnapshot().queueIndex).toBe(2);
  });
});

describe('editing the queue', () => {
  it('removing the entry that is playing plays the one that took its place', async () => {
    const { store, engine } = await setup();
    store.setQueue(entries, 0);
    await playingTrack(engine, entries[0]!.track.trackId);

    store.removeFromQueue(entries[0]!.id);
    await playingTrack(engine, entries[1]!.track.trackId);
    expect(store.current()?.id).toBe(entries[1]!.id);
  });

  it('removing the only entry stops playback', async () => {
    const { store, engine } = await setup();
    store.setQueue([entries[0]!], 0);
    await playingTrack(engine, entries[0]!.track.trackId);

    store.removeFromQueue(entries[0]!.id);
    expect(engine.getState()).toMatchObject({ status: 'idle', trackId: null });
    expect(store.getSnapshot().queueIndex).toBe(-1);
  });

  it('offers next by the shuffled order, not by the queue position', async () => {
    const { store, engine } = await setup();
    await store.setShuffle(true);
    store.setQueue(entries, 2);
    await playingTrack(engine, entries[2]!.track.trackId);
    expect(store.getSnapshot().queueIndex).toBe(2);
    expect(store.canGoNext()).toBe(true);
    expect(store.canGoPrevious(), 'nothing has been heard before this one').toBe(false);

    await store.next('user');
    await playingTrack(engine, store.current()!.track.trackId);
    expect(store.canGoPrevious()).toBe(true);
    await store.next('user');
    expect(store.canGoNext(), 'the pass is over').toBe(false);
  });
});
