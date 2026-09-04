/**
 * Media Session integration.
 *
 * The important assertion here is the honest one: the report must say that a PWA cannot appear on
 * the Android Auto or CarPlay home screen. If someone later "fixes" that claim to look better, this
 * fails — which is exactly what it is for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installHandlers, mediaIntegrationReport, mediaSessionSupported, publishMetadata, publishPlaybackState, publishPosition } from '../../src/lib/media-session.js';
import type { TrackRef } from '@now-playing/contracts';

const TRACK: TrackRef = {
  trackId: '11111111-1111-7111-8111-111111111111',
  title: 'Ember Line',
  artistName: 'Test Artist',
  albumName: 'Test Album',
  durationMs: 180_000,
  artworkId: null,
  identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} },
  locators: [],
  provider: 'local',
  genre: null,
  year: null,
};

interface FakeSession {
  metadata: unknown;
  playbackState: string;
  handlers: Map<string, unknown>;
  positions: unknown[];
  setActionHandler(action: string, handler: unknown): void;
  setPositionState(state: unknown): void;
}

function installFakeSession(options: { unsupportedActions?: string[] } = {}): FakeSession {
  const session: FakeSession = {
    metadata: null,
    playbackState: 'none',
    handlers: new Map(),
    positions: [],
    setActionHandler(action, handler) {
      if (options.unsupportedActions?.includes(action)) throw new TypeError(`Unsupported action ${action}`);
      if (handler === null) session.handlers.delete(action);
      else session.handlers.set(action, handler);
    },
    setPositionState(state) {
      const s = state as { duration: number; position: number };
      if (s.position > s.duration) throw new TypeError('position past duration');
      session.positions.push(state);
    },
  };
  vi.stubGlobal('navigator', { mediaSession: session, userAgent: 'test' });
  vi.stubGlobal('MediaMetadata', class {
    constructor(readonly init: unknown) {}
  });
  return session;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capability detection', () => {
  it('reports no support when the browser has no media session', () => {
    vi.stubGlobal('navigator', { userAgent: 'test' });
    expect(mediaSessionSupported()).toBe(false);
    expect(mediaIntegrationReport().supported).toBe(false);
  });

  it('never claims an Android Auto or CarPlay home-screen tile is possible', () => {
    installFakeSession();
    const report = mediaIntegrationReport();
    const tile = report.features.find((f) => f.name.includes('Android Auto'));
    expect(tile).toBeDefined();
    expect(tile!.available).toBe(false);
    expect(tile!.note).toMatch(/native apps/i);
  });

  it('reports the features that do work as available', () => {
    installFakeSession();
    const report = mediaIntegrationReport();
    expect(report.features.find((f) => f.name.includes('lock screen'))?.available).toBe(true);
    expect(report.features.find((f) => f.name.includes('car and headset buttons'))?.available).toBe(true);
  });

  it('reports an unsupported action as unavailable rather than assuming', () => {
    installFakeSession({ unsupportedActions: ['seekto'] });
    const report = mediaIntegrationReport();
    expect(report.features.find((f) => f.name.includes('Scrubbing'))?.available).toBe(false);
  });
});

describe('publishing', () => {
  it('publishes title, artist and album for the car display', () => {
    const session = installFakeSession();
    publishMetadata(TRACK, null);
    expect((session.metadata as { init: { title: string; artist: string; album: string } }).init).toMatchObject({ title: 'Ember Line', artist: 'Test Artist', album: 'Test Album' });
  });

  it('clears the metadata when nothing is playing', () => {
    const session = installFakeSession();
    publishMetadata(TRACK, null);
    publishMetadata(null, null);
    expect(session.metadata).toBeNull();
  });

  it('publishes playback state', () => {
    const session = installFakeSession();
    publishPlaybackState('playing');
    expect(session.playbackState).toBe('playing');
  });

  it('publishes a position the car can show', () => {
    const session = installFakeSession();
    publishPosition(30_000, 180_000);
    expect(session.positions).toEqual([{ duration: 180, position: 30, playbackRate: 1 }]);
  });

  it('clamps a position past the end instead of throwing at the car', () => {
    const session = installFakeSession();
    publishPosition(999_000, 180_000);
    expect(session.positions).toEqual([{ duration: 180, position: 180, playbackRate: 1 }]);
  });

  it('publishes nothing when the duration is unknown', () => {
    const session = installFakeSession();
    publishPosition(30_000, null);
    expect(session.positions).toEqual([]);
  });
});

describe('handlers', () => {
  it('installs every transport action and removes them again', () => {
    const session = installFakeSession();
    const calls: string[] = [];
    const remove = installHandlers({
      play: () => void calls.push('play'),
      pause: () => void calls.push('pause'),
      stop: () => void calls.push('stop'),
      previous: () => void calls.push('previous'),
      next: () => void calls.push('next'),
      seekTo: (ms) => void calls.push(`seekTo:${ms}`),
      seekBy: (s) => void calls.push(`seekBy:${s}`),
    });
    expect([...session.handlers.keys()].sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack', 'seekbackward', 'seekforward', 'seekto', 'stop']);

    (session.handlers.get('play') as () => void)();
    (session.handlers.get('nexttrack') as () => void)();
    (session.handlers.get('seekto') as (d: { seekTime: number }) => void)({ seekTime: 42 });
    (session.handlers.get('seekforward') as (d: { seekOffset?: number }) => void)({});
    expect(calls).toEqual(['play', 'next', 'seekTo:42000', 'seekBy:10']);

    remove();
    expect(session.handlers.size).toBe(0);
  });

  it('installs the actions the browser does support when one is rejected', () => {
    const session = installFakeSession({ unsupportedActions: ['seekto'] });
    installHandlers({ play: () => undefined, pause: () => undefined, stop: () => undefined, previous: () => undefined, next: () => undefined, seekTo: () => undefined, seekBy: () => undefined });
    expect(session.handlers.has('play')).toBe(true);
    expect(session.handlers.has('seekto')).toBe(false);
  });

  it('does nothing at all without media session support', () => {
    vi.stubGlobal('navigator', { userAgent: 'test' });
    const remove = installHandlers({ play: () => undefined, pause: () => undefined, stop: () => undefined, previous: () => undefined, next: () => undefined, seekTo: () => undefined, seekBy: () => undefined });
    expect(() => remove()).not.toThrow();
  });
});
