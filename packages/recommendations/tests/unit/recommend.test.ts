import { describe, expect, it } from 'vitest';
import type { CanonicalTrack, ListeningEvent } from '@now-playing/contracts';
import { generateListeningEvents } from '@now-playing/test-fixtures';
import {
  DEFAULT_RECOMMENDATION_CONFIG,
  aggregateLeaksTrackIds,
  applyEvents,
  applySeeds,
  buildCooccurrence,
  buildCatalogue,
  catalogueFromEvents,
  cohortFromGenerator,
  createProfile,
  diversify,
  evaluate,
  profileToAggregate,
  rankCandidates,
  recommend,
  seedsFromAggregate,
  sessionsFromEvents,
  sourcesForMode,
  syntheticCatalogue,
  tierTargets,
  type TasteProfile,
} from '../../src/index.js';

const T0 = Date.parse('2026-08-01T12:00:00.000Z');
const NOW = Date.parse('2026-09-01T00:00:00.000Z');
const USER = '00000000-0000-7000-8000-000000000001';
const DEVICE = '00000000-0000-7000-8000-00000000bbbb';

function pad(n: number): string {
  return String(n).padStart(12, '0');
}

function canonical(index: number, title: string, artistName: string, genre: string, year = 2020, popularity = 0.5): CanonicalTrack {
  // Offset so a track id can never collide with the user or device ids used in these fixtures.
  const id = `00000000-0000-7000-8000-${pad(100_000 + index)}`;
  return { id, musicbrainzRecordingId: null, isrc: null, title, normalizedTitle: title.toLowerCase(), artistId: null, artistName, normalizedArtist: artistName.toLowerCase(), albumId: null, albumName: `${artistName} — ${title}`, releaseYear: year, durationMs: 200_000, genres: [genre], tags: [], popularity, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

/** A catalogue with three artists per genre so artist and genre caps have something to bite on. */
function testCatalogue(): CanonicalTrack[] {
  const out: CanonicalTrack[] = [];
  const genres = ['ambient', 'indie', 'electronic', 'folk'];
  let i = 1;
  for (const genre of genres) {
    for (let a = 0; a < 4; a += 1) {
      const artist = `${genre} artist ${a}`;
      for (let t = 0; t < 5; t += 1) {
        out.push(canonical(i, `${genre} track ${a}-${t}`, artist, genre, 2015 + ((i * 3) % 11), ((i * 7) % 100) / 100));
        i += 1;
      }
    }
  }
  return out;
}

let counter = 0;
function play(trackId: string, track: CanonicalTrack, type: ListeningEvent['type'], atMs: number, extra: Partial<ListeningEvent> = {}): ListeningEvent {
  counter += 1;
  return {
    id: `00000000-0000-7000-8000-${pad(500_000 + counter)}`,
    schemaVersion: 1,
    type,
    occurredAt: new Date(atMs).toISOString(),
    sessionId: `00000000-0000-7000-8000-${pad(700_000 + Math.floor(atMs / 3_600_000) % 1000)}`,
    deviceId: DEVICE,
    mode: 'solo',
    groupId: null,
    trackId,
    track: { title: track.title, artistName: track.artistName, artistId: null, albumName: track.albumName, albumId: null, genre: track.genres[0] ?? null, tags: [], year: track.releaseYear, durationMs: track.durationMs, provider: 'local', popularity: track.popularity },
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
    ...extra,
  };
}

/** A listener who loves the first two ambient artists and skips one indie artist repeatedly. */
function warmProfile(catalogue: CanonicalTrack[]): TasteProfile {
  let profile = createProfile(USER, T0);
  const loved = catalogue.filter((t) => t.artistName === 'ambient artist 0' || t.artistName === 'ambient artist 1');
  const hated = catalogue.filter((t) => t.artistName === 'indie artist 3');
  const events: ListeningEvent[] = [];
  let at = T0;
  for (let round = 0; round < 4; round += 1) {
    for (const track of loved) {
      events.push(play(track.id, track, 'completed', (at += 300_000), { secondsPlayed: 200, completionPercent: 100 }));
      if (round === 0) events.push(play(track.id, track, 'liked', (at += 1000)));
    }
    for (const track of hated) events.push(play(track.id, track, 'skipped', (at += 60_000), { secondsPlayed: 3, positionMs: 3000 }));
  }
  profile = applyEvents(profile, events, DEFAULT_RECOMMENDATION_CONFIG, at);
  return profile;
}

describe('recommend', () => {
  const catalogue = testCatalogue();

  it('is deterministic for the same inputs and seed', () => {
    const profile = warmProfile(catalogue);
    const a = recommend({ userId: USER, profile, catalogue, seed: 7, now: NOW });
    const b = recommend({ userId: USER, profile, catalogue, seed: 7, now: NOW });
    expect(a.recommendations.map((r) => r.canonicalTrackId)).toEqual(b.recommendations.map((r) => r.canonicalTrackId));
    expect(a.recommendations.map((r) => r.score)).toEqual(b.recommendations.map((r) => r.score));
  });

  it('returns the requested number of recommendations from a large enough catalogue', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 12, seed: 1, now: NOW });
    expect(result.recommendations).toHaveLength(12);
    expect(result.diagnostics.shortfallReason).toBeNull();
    expect(new Set(result.recommendations.map((r) => r.canonicalTrackId)).size).toBe(12);
  });

  it('explains every recommendation with at least one reason', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 10, seed: 2, now: NOW });
    for (const r of result.recommendations) {
      expect(r.reasons.length).toBeGreaterThan(0);
      expect(r.reasons[0]!.text.length).toBeGreaterThan(3);
    }
  });

  it('respects the per-artist cap', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 3, now: NOW });
    const counts = new Map<string, number>();
    for (const r of result.recommendations) counts.set(r.artistName, (counts.get(r.artistName) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(DEFAULT_RECOMMENDATION_CONFIG.diversity.maxPerArtist);
  });

  it('respects the genre share cap', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 4, now: NOW });
    const counts = new Map<string, number>();
    for (const r of result.recommendations) counts.set(r.genre ?? 'unknown', (counts.get(r.genre ?? 'unknown') ?? 0) + 1);
    const cap = Math.ceil(result.recommendations.length * DEFAULT_RECOMMENDATION_CONFIG.diversity.maxGenreShare);
    for (const [, n] of counts) expect(n).toBeLessThanOrEqual(cap);
  });

  it('excludes recently played tracks by default', () => {
    const profile = warmProfile(catalogue);
    const recent = catalogue.slice(0, 6).map((t) => t.id);
    const result = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 5, now: NOW, context: { recentlyPlayedIds: recent } });
    for (const r of result.recommendations) expect(recent).not.toContain(r.canonicalTrackId);
  });

  it('penalises tracks that have been shown many times before', () => {
    const profile = warmProfile(catalogue);
    const plain = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 6, now: NOW });
    const victim = plain.recommendations[0]!.canonicalTrackId;
    const punished = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 6, now: NOW, context: { recentlyRecommended: { [victim]: 12 } } });
    const before = plain.scored.find((s) => s.trackId === victim)!.score;
    const after = punished.scored.find((s) => s.trackId === victim);
    if (after) expect(after.score).toBeLessThan(before);
    else expect(punished.recommendations.map((r) => r.canonicalTrackId)).not.toContain(victim);
  });

  it('rarely returns an artist the listener keeps skipping', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 20, seed: 8, now: NOW });
    const skipped = result.recommendations.filter((r) => r.artistName === 'indie artist 3');
    expect(skipped.length).toBeLessThanOrEqual(1);
  });

  it('deep discovery avoids owned tracks and the listener’s top artists', () => {
    const profile = warmProfile(catalogue);
    const owned = catalogue.filter((t) => t.genres[0] === 'ambient').map((t) => t.id);
    const result = recommend({ userId: USER, profile, catalogue, mode: 'deep', limit: 10, seed: 9, now: NOW, context: { ownedTrackIds: owned } });
    for (const r of result.recommendations) {
      expect(owned).not.toContain(r.canonicalTrackId);
      expect(r.artistName).not.toBe('ambient artist 0');
      expect(r.artistName).not.toBe('ambient artist 1');
    }
  });

  it('genre mode returns only that genre', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, mode: 'genre', limit: 8, seed: 10, now: NOW, context: { genre: 'folk' } });
    expect(result.recommendations.length).toBeGreaterThan(0);
    for (const r of result.recommendations) expect(r.genre).toBe('folk');
  });

  it('new releases returns only recent years and never something already owned', () => {
    const profile = warmProfile(catalogue);
    const fresh = [...catalogue, canonical(9001, 'Brand New', 'ambient artist 2', 'ambient', 2026, 0.6), canonical(9002, 'Also New', 'indie artist 0', 'indie', 2026, 0.4)];
    const owned = ['00000000-0000-7000-8000-000000109001'];
    const result = recommend({ userId: USER, profile, catalogue: fresh, mode: 'new-releases', limit: 5, seed: 11, now: NOW, context: { ownedTrackIds: owned } });
    for (const r of result.recommendations) {
      expect(r.year).toBeGreaterThanOrEqual(2025);
      expect(owned).not.toContain(r.canonicalTrackId);
    }
  });

  it('similar mode is anchored on the seed track and never returns it', () => {
    const profile = warmProfile(catalogue);
    const seedTrack = catalogue.find((t) => t.artistName === 'electronic artist 1')!;
    const result = recommend({ userId: USER, profile, catalogue, mode: 'similar', limit: 6, seed: 12, now: NOW, context: { seedTrackId: seedTrack.id } });
    expect(result.recommendations.map((r) => r.canonicalTrackId)).not.toContain(seedTrack.id);
    expect(result.diagnostics.contextLabel).toBe(seedTrack.title);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('playlist mode extends a playlist without repeating it', () => {
    const profile = warmProfile(catalogue);
    const playlist = catalogue.filter((t) => t.genres[0] === 'folk').slice(0, 4);
    const result = recommend({
      userId: USER,
      profile,
      catalogue,
      mode: 'playlist',
      limit: 8,
      seed: 13,
      now: NOW,
      context: { playlistTrackIds: playlist.map((t) => t.id), playlistId: '00000000-0000-7000-8000-0000000000p1', playlistName: 'Sunday Folk' },
    });
    const ids = result.recommendations.map((r) => r.canonicalTrackId);
    for (const t of playlist) expect(ids).not.toContain(t.id);
    expect(result.diagnostics.contextLabel).toBe('Sunday Folk');
  });

  it('each mode draws only from its documented sources', () => {
    expect(sourcesForMode('new-releases')).toEqual(['new-release']);
    expect(sourcesForMode('deep')).not.toContain('top-artist');
    expect(sourcesForMode('for-you')).toContain('collaborative');
  });

  it('marks cold start and still returns something useful from seeds', () => {
    const seeded = applySeeds(createProfile(USER, T0), { artists: ['folk artist 1'], genres: ['folk'] }, DEFAULT_RECOMMENDATION_CONFIG, T0);
    const result = recommend({ userId: USER, profile: seeded, catalogue, limit: 10, seed: 14, now: NOW });
    expect(result.diagnostics.coldStart).toBe(true);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.some((r) => r.genre === 'folk')).toBe(true);
  });

  it('says why it could not fill the list instead of padding it', () => {
    const profile = warmProfile(catalogue);
    const tiny = catalogue.slice(0, 3);
    const result = recommend({ userId: USER, profile, catalogue: tiny, limit: 25, seed: 15, now: NOW });
    expect(result.recommendations.length).toBeLessThan(25);
    expect(result.diagnostics.shortfallReason).toMatch(/could be filled|No candidate/);
  });

  it('carries provider availability through to the result', () => {
    const profile = warmProfile(catalogue);
    const track = catalogue[0]!;
    const result = recommend({
      userId: USER,
      profile,
      catalogue,
      limit: 20,
      seed: 16,
      now: NOW,
      platforms: [{ trackId: track.id, provider: 'soundcloud', providerTrackId: '123', url: 'https://soundcloud.com/x/y', availability: 'available', lastVerifiedAt: null }],
    });
    const found = result.recommendations.find((r) => r.canonicalTrackId === track.id);
    if (found) {
      expect(found.availability[0]!.provider).toBe('soundcloud');
      expect(found.availability[0]!.playable).toBe(true);
    }
  });

  it('reports which sources contributed', () => {
    const profile = warmProfile(catalogue);
    const result = recommend({ userId: USER, profile, catalogue, limit: 10, seed: 17, now: NOW });
    expect(Object.keys(result.diagnostics.sources).length).toBeGreaterThan(1);
    expect(result.diagnostics.candidateCount).toBeGreaterThan(10);
  });
});

describe('collaborative signal', () => {
  it('links tracks that appear in the same sessions', () => {
    const catalogue = testCatalogue();
    const a = catalogue[0]!.id;
    const b = catalogue[1]!.id;
    const c = catalogue[10]!.id;
    const cooc = buildCooccurrence([
      [a, b],
      [a, b],
      [a, b],
      [c],
    ]);
    const neighbours = cooc.neighbours[a] ?? [];
    expect(neighbours[0]?.trackId).toBe(b);
    expect(neighbours.find((n) => n.trackId === c)).toBeUndefined();
  });

  it('derives sessions from a listening history', () => {
    const events = generateListeningEvents({ seed: 3, deviceId: DEVICE, days: 5 });
    const sessions = sessionsFromEvents(events);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.length > 0)).toBe(true);
  });
});

describe('diversity pass', () => {
  it('apportions tiers so targets sum exactly to the limit', () => {
    const targets = tierTargets({ strong: 0.4, related: 0.3, emerging: 0.2, experimental: 0.1 }, 10);
    expect(targets).toEqual({ strong: 4, related: 3, emerging: 2, experimental: 1 });
    const odd = tierTargets({ strong: 0.4, related: 0.3, emerging: 0.2, experimental: 0.1 }, 7);
    expect(odd.strong + odd.related + odd.emerging + odd.experimental).toBe(7);
  });

  it('falls back to the best remaining candidates when a tier is under-supplied', () => {
    const catalogue = buildCatalogue(testCatalogue());
    const profile = warmProfile(testCatalogue());
    const candidates = testCatalogue()
      .slice(0, 12)
      .map((track) => ({ trackId: track.id, track, sources: [{ kind: 'top-artist' as const, via: null, score: 0.5 }], reasons: [] }));
    const scored = rankCandidates(candidates, profile, {
      now: NOW,
      mode: 'for-you',
      catalogue,
      recentlyPlayedIds: new Set(),
      recentlyRecommended: {},
      cooccurrence: null,
      contextKeys: [],
      contextTracks: [],
      contextLabel: null,
      coldStart: false,
    });
    const result = diversify(scored, DEFAULT_RECOMMENDATION_CONFIG, { limit: 10 });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(10);
  });
});

describe('aggregate profile', () => {
  it('refuses to build an aggregate from too few artists', () => {
    const catalogue = testCatalogue();
    const profile = warmProfile(catalogue);
    const result = profileToAggregate(profile, { kAnonymity: 20 });
    expect(result.profile).toBeNull();
    expect(result.reason).toMatch(/at least 20 artists/);
  });

  it('never carries track ids', () => {
    const catalogue = testCatalogue();
    let profile = createProfile(USER, T0);
    const events: ListeningEvent[] = [];
    let at = T0;
    for (const track of catalogue.slice(0, 30)) {
      for (let i = 0; i < 3; i += 1) events.push(play(track.id, track, 'completed', (at += 300_000), { secondsPlayed: 200, completionPercent: 100 }));
    }
    profile = applyEvents(profile, events, DEFAULT_RECOMMENDATION_CONFIG, at);
    const { profile: aggregate } = profileToAggregate(profile, { now: NOW });
    expect(aggregate).not.toBeNull();
    expect(aggregateLeaksTrackIds(aggregate!, catalogue.map((t) => t.id))).toEqual([]);
    expect(JSON.stringify(aggregate)).not.toContain(catalogue[0]!.id);
  });

  it('rounds the computed timestamp to a week so it is not a fingerprint', () => {
    const catalogue = testCatalogue();
    let profile = createProfile(USER, T0);
    const events: ListeningEvent[] = [];
    let at = T0;
    for (const track of catalogue.slice(0, 30)) for (let i = 0; i < 3; i += 1) events.push(play(track.id, track, 'completed', (at += 300_000), { secondsPlayed: 200, completionPercent: 100 }));
    profile = applyEvents(profile, events, DEFAULT_RECOMMENDATION_CONFIG, at);
    const a = profileToAggregate(profile, { now: NOW }).profile!;
    const b = profileToAggregate(profile, { now: NOW + 3600_000 }).profile!;
    expect(a.computedAt).toBe(b.computedAt);
  });

  it('round-trips into cold-start seeds', () => {
    const catalogue = testCatalogue();
    let profile = createProfile(USER, T0);
    const events: ListeningEvent[] = [];
    let at = T0;
    for (const track of catalogue.slice(0, 30)) for (let i = 0; i < 3; i += 1) events.push(play(track.id, track, 'completed', (at += 300_000), { secondsPlayed: 200, completionPercent: 100 }));
    profile = applyEvents(profile, events, DEFAULT_RECOMMENDATION_CONFIG, at);
    const aggregate = profileToAggregate(profile, { now: NOW }).profile!;
    const seeds = seedsFromAggregate(aggregate);
    expect(seeds.artists!.length).toBeGreaterThan(0);
    expect(seeds.likedTrackIds).toEqual([]);
  });
});

describe('offline evaluation', () => {
  it('produces finite metrics on a synthetic cohort', () => {
    const users = cohortFromGenerator((seed, deviceId) => generateListeningEvents({ seed, deviceId, days: 14 }), 4);
    const seedTracks = catalogueFromEvents(users.flatMap((u) => u.events));
    const catalogue = syntheticCatalogue(seedTracks, { size: 80, seed: 11 });
    const report = evaluate({ users, catalogue, k: 10, seed: 42, modes: ['for-you', 'deep'] });
    expect(report.users).toBe(4);
    expect(report.modes).toHaveLength(2);
    for (const m of report.modes) {
      expect(Number.isFinite(m.hitRate)).toBe(true);
      expect(m.ndcg).toBeGreaterThanOrEqual(0);
      expect(m.artistDiversity).toBeGreaterThanOrEqual(0);
      expect(m.skipPrecision).toBeGreaterThan(0.5);
    }
    expect(report.notes.some((n) => n.includes('Synthetic fixtures'))).toBe(true);
  });

  it('is reproducible', () => {
    const users = cohortFromGenerator((seed, deviceId) => generateListeningEvents({ seed, deviceId, days: 10 }), 3);
    const catalogue = syntheticCatalogue(catalogueFromEvents(users.flatMap((u) => u.events)), { size: 60, seed: 5 });
    const a = evaluate({ users, catalogue, k: 8, seed: 1, modes: ['for-you'] });
    const b = evaluate({ users, catalogue, k: 8, seed: 1, modes: ['for-you'] });
    expect(a.modes).toEqual(b.modes);
  });

  it('synthesises a catalogue deterministically around the seed tracks', () => {
    const seeds = [canonical(1, 'A', 'artist a', 'ambient')];
    const one = syntheticCatalogue(seeds, { size: 20, seed: 3 });
    const two = syntheticCatalogue(seeds, { size: 20, seed: 3 });
    expect(one.map((t) => t.id)).toEqual(two.map((t) => t.id));
    expect(one).toHaveLength(20);
    expect(one[0]!.id).toBe(seeds[0]!.id);
  });
});
