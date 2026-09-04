import { describe, expect, it } from 'vitest';
import type { CanonicalTrack, ListeningEvent } from '@now-playing/contracts';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  applyEvents,
  applyFeedback,
  applySeeds,
  createProfile,
  decayFactor,
  deserializeProfile,
  isColdStart,
  mergeConfig,
  profileView,
  serializeProfile,
  validateConfig,
} from '../../src/index.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-08-01T12:00:00.000Z');
const USER = '00000000-0000-7000-8000-000000000001';

let counter = 0;
function eventId(): string {
  counter += 1;
  return `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

function event(patch: Partial<ListeningEvent> & Pick<ListeningEvent, 'type'>, atMs = T0): ListeningEvent {
  return {
    id: eventId(),
    schemaVersion: 1,
    occurredAt: new Date(atMs).toISOString(),
    sessionId: '00000000-0000-7000-8000-00000000aaaa',
    deviceId: '00000000-0000-7000-8000-00000000bbbb',
    mode: 'solo',
    groupId: null,
    trackId: '00000000-0000-7000-8000-000000000t01',
    track: { title: 'Ember Line', artistName: 'Fennel Grove', artistId: null, albumName: 'Long Wave Sessions', albumId: null, genre: 'Ambient', tags: [], year: 2019, durationMs: 200_000, provider: 'local', popularity: 0.4 },
    positionMs: null,
    secondsPlayed: null,
    completionPercent: null,
    reason: null,
    playlistId: null,
    presetId: null,
    recommendationId: null,
    contextKind: 'manual',
    contextId: null,
    mood: null,
    activity: null,
    ...patch,
  };
}

function trackEvent(trackId: string, title: string, artistName: string, genre: string, type: ListeningEvent['type'], atMs: number, extra: Partial<ListeningEvent> = {}): ListeningEvent {
  return event({ type, trackId, track: { title, artistName, artistId: null, albumName: `${title} EP`, albumId: null, genre, tags: [], year: 2020, durationMs: 200_000, provider: 'local', popularity: 0.5 }, ...extra }, atMs);
}

function canonical(id: string, title: string, artistName: string, genre: string, year = 2020): CanonicalTrack {
  return { id, musicbrainzRecordingId: null, isrc: null, title, normalizedTitle: title.toLowerCase(), artistId: null, artistName, normalizedArtist: artistName.toLowerCase(), albumId: null, albumName: `${title} EP`, releaseYear: year, durationMs: 200_000, genres: [genre.toLowerCase()], tags: [], popularity: 0.5, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

describe('configuration', () => {
  it('ships the documented action weights', () => {
    const w = DEFAULT_RECOMMENDATION_CONFIG.actionWeights;
    expect(w.immediateSkip).toBe(-5);
    expect(w.earlySkip).toBe(-3);
    expect(w.partial).toBe(0.5);
    expect(w.majority).toBe(2);
    expect(w.completed).toBe(3);
    expect(w.replay).toBe(4);
    expect(w.like).toBe(6);
    expect(w.playlistAdd).toBe(7);
    expect(w.favorite).toBe(10);
  });

  it('ships the documented ranking weights, which sum to 1', () => {
    const r = DEFAULT_RECOMMENDATION_CONFIG.ranking;
    expect(r).toEqual({ tasteMatch: 0.3, artistAffinity: 0.2, genreAffinity: 0.15, collaborative: 0.1, recency: 0.1, popularityFit: 0.05, moodContext: 0.05, discoveryBonus: 0.05 });
    expect(Object.values(r).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('merges a partial override without mutating the default', () => {
    const merged = mergeConfig({ decay: { halfLifeDays: 10 } });
    expect(merged.decay.halfLifeDays).toBe(10);
    expect(merged.actionWeights.like).toBe(6);
    expect(DEFAULT_RECOMMENDATION_CONFIG.decay.halfLifeDays).toBe(45);
  });

  it('rejects nonsense configuration rather than silently misbehaving', () => {
    expect(() => mergeConfig({ decay: { halfLifeDays: 0 } })).toThrow();
    expect(() => mergeConfig({ skipThresholds: { immediateFraction: 0.9, earlyFraction: 0.2 } })).toThrow();
    expect(() => validateConfig(DEFAULT_RECOMMENDATION_CONFIG)).not.toThrow();
  });
});

describe('taste profile', () => {
  it('starts empty and in cold start', () => {
    const p = createProfile(USER, T0);
    expect(p.eventCount).toBe(0);
    expect(isColdStart(p)).toBe(true);
  });

  it('rewards a completion and records the artist', () => {
    const p = applyEvents(createProfile(USER, T0), [event({ type: 'completed', secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    expect(p.eventCount).toBe(1);
    expect(p.dims.tracks['00000000-0000-7000-8000-000000000t01']!.w).toBeGreaterThan(0);
    expect(Object.values(p.dims.artists)[0]!.w).toBeGreaterThan(0);
    expect(Object.values(p.dims.genres)[0]!.w).toBeGreaterThan(0);
  });

  it('is idempotent: replaying the same event ids changes nothing', () => {
    const events = [event({ type: 'completed', secondsPlayed: 200, completionPercent: 100 }), event({ type: 'liked' })];
    const once = applyEvents(createProfile(USER, T0), events, DEFAULT_RECOMMENDATION_CONFIG, T0);
    const twice = applyEvents(once, events, DEFAULT_RECOMMENDATION_CONFIG, T0);
    expect(twice.eventCount).toBe(once.eventCount);
    expect(twice.dims.tracks).toEqual(once.dims.tracks);
  });

  it('weights a favourite above a like above a completion', () => {
    const base = createProfile(USER, T0);
    const completed = applyEvents(base, [event({ type: 'completed', secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const liked = applyEvents(base, [event({ type: 'liked' })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const favorited = applyEvents(base, [event({ type: 'favorited' })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const w = (p: typeof base) => p.dims.tracks['00000000-0000-7000-8000-000000000t01']!.w;
    expect(w(liked)).toBeGreaterThan(w(completed));
    expect(w(favorited)).toBeGreaterThan(w(liked));
  });

  it('an immediate skip is punished harder than an early one', () => {
    const base = createProfile(USER, T0);
    const immediate = applyEvents(base, [event({ type: 'skipped', secondsPlayed: 4, positionMs: 4000 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const early = applyEvents(base, [event({ type: 'skipped', secondsPlayed: 50, positionMs: 50_000 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const w = (p: typeof base) => p.dims.tracks['00000000-0000-7000-8000-000000000t01']!.w;
    expect(w(immediate)).toBeLessThan(w(early));
    expect(w(immediate)).toBeLessThan(0);
  });

  it('a single skip lowers only that track, never the artist or genre', () => {
    let p = applyEvents(createProfile(USER, T0), [trackEvent('t-a', 'A', 'Fennel Grove', 'Ambient', 'completed', T0, { secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const artistBefore = Object.values(p.dims.artists)[0]!.w;
    p = applyEvents(p, [trackEvent('t-b', 'B', 'Fennel Grove', 'Ambient', 'skipped', T0 + 1000, { secondsPlayed: 3, positionMs: 3000 })], DEFAULT_RECOMMENDATION_CONFIG, T0 + 1000);
    expect(p.dims.tracks['t-b']!.w).toBeLessThan(0);
    expect(p.skips.artists['fennel grove'] ?? []).toBeDefined();
    // Only time decay may move the artist weight; the skip itself must not touch it.
    expect(Object.values(p.dims.artists)[0]!.w).toBeGreaterThan(artistBefore * 0.999);
  });

  it('lowers the artist only after repeated skips of different tracks', () => {
    let p = createProfile(USER, T0);
    p = applyEvents(p, [trackEvent('t-1', 'One', 'Velvet Antenna', 'Noise', 'completed', T0, { secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const before = p.dims.artists['velvet antenna']!.w;
    for (let i = 0; i < 2; i += 1) {
      p = applyEvents(p, [trackEvent(`t-s${i}`, `S${i}`, 'Velvet Antenna', 'Noise', 'skipped', T0 + i * 1000, { secondsPlayed: 2, positionMs: 2000 })], DEFAULT_RECOMMENDATION_CONFIG, T0 + i * 1000);
    }
    expect(p.dims.artists['velvet antenna']!.w).toBeGreaterThan(before * 0.999);
    p = applyEvents(p, [trackEvent('t-s3', 'S3', 'Velvet Antenna', 'Noise', 'skipped', T0 + 5000, { secondsPlayed: 2, positionMs: 2000 })], DEFAULT_RECOMMENDATION_CONFIG, T0 + 5000);
    expect(p.dims.artists['velvet antenna']!.w).toBeLessThan(before);
  });

  it('decays by half over one half-life', () => {
    expect(decayFactor(0, 45)).toBeCloseTo(1, 9);
    expect(decayFactor(45 * DAY, 45)).toBeCloseTo(0.5, 9);
    expect(decayFactor(90 * DAY, 45)).toBeCloseTo(0.25, 9);
  });

  it('an old like counts for less than a fresh one', () => {
    const old = applyEvents(createProfile(USER, T0), [event({ type: 'liked' }, T0)], DEFAULT_RECOMMENDATION_CONFIG, T0 + 90 * DAY);
    const fresh = applyEvents(createProfile(USER, T0), [event({ type: 'liked' }, T0 + 90 * DAY)], DEFAULT_RECOMMENDATION_CONFIG, T0 + 90 * DAY);
    const key = '00000000-0000-7000-8000-000000000t01';
    expect(old.dims.tracks[key]!.w).toBeLessThan(fresh.dims.tracks[key]!.w);
  });

  it('applies explicit feedback and treats a repeat as a no-op', () => {
    const p = createProfile(USER, T0);
    const disliked = applyFeedback(p, { recommendationId: '00000000-0000-7000-8000-00000000f001', trackId: 't-x', feedback: 'less-from-artist', artistName: 'Fennel Grove', genres: ['ambient'] }, DEFAULT_RECOMMENDATION_CONFIG, T0);
    expect(disliked.dims.artists['fennel grove']!.w).toBeLessThan(0);
    const again = applyFeedback(disliked, { recommendationId: '00000000-0000-7000-8000-00000000f001', trackId: 't-x', feedback: 'less-from-artist', artistName: 'Fennel Grove', genres: ['ambient'] }, DEFAULT_RECOMMENDATION_CONFIG, T0);
    expect(again.dims.artists['fennel grove']!.w).toBe(disliked.dims.artists['fennel grove']!.w);
  });

  it('seeds a cold profile from names alone', () => {
    const p = applySeeds(createProfile(USER, T0), { artists: ['Cassette Bloom'], genres: ['Indie'], likedTrackIds: ['t-1'] }, DEFAULT_RECOMMENDATION_CONFIG, T0);
    expect(p.dims.artists['cassette bloom']!.w).toBeGreaterThan(0);
    expect(p.dims.genres['indie']!.w).toBeGreaterThan(0);
    expect(p.seeds?.artists).toContain('Cassette Bloom');
  });

  it('leaves cold start only once there is enough evidence', () => {
    let p = createProfile(USER, T0);
    expect(isColdStart(p)).toBe(true);
    const artists = ['Fennel Grove', 'Cassette Bloom', 'Orbital Cartographers'];
    for (let i = 0; i < 24; i += 1) {
      const artist = artists[i % artists.length]!;
      p = applyEvents(p, [trackEvent(`t-${i}`, `Track ${i}`, artist, 'Ambient', 'completed', T0 + i * 60_000, { secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0 + i * 60_000);
    }
    expect(isColdStart(p)).toBe(false);
  });

  it('round-trips through serialize/deserialize', () => {
    const p = applyEvents(createProfile(USER, T0), [event({ type: 'completed', secondsPlayed: 200, completionPercent: 100 }), event({ type: 'liked' })], DEFAULT_RECOMMENDATION_CONFIG, T0);
    const restored = deserializeProfile(serializeProfile(p));
    expect(restored).toEqual(p);
  });

  it('refuses to deserialize something that is not a profile', () => {
    expect(() => deserializeProfile('{"nope":true}')).toThrow();
    expect(() => deserializeProfile('not json')).toThrow();
  });

  it('exposes an inspectable view with normalised weights', () => {
    let p = createProfile(USER, T0);
    for (let i = 0; i < 6; i += 1) p = applyEvents(p, [trackEvent(`t-${i}`, `Track ${i}`, i < 4 ? 'Fennel Grove' : 'Cassette Bloom', 'Ambient', 'completed', T0 + i * 1000, { secondsPlayed: 200, completionPercent: 100 })], DEFAULT_RECOMMENDATION_CONFIG, T0 + i * 1000);
    const view = profileView(p);
    const artists = view.dimensions['artists'] ?? [];
    expect(artists[0]!.key).toBe('fennel grove');
    expect(artists[0]!.weight).toBeCloseTo(1, 6);
    expect(view.eventCount).toBe(6);
    expect(view.coldStart).toBe(true);
  });
});

export { canonical, trackEvent, T0, USER, DAY };
