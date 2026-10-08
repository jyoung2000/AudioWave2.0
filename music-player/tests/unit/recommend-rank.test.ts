/**
 * The ranker behind Discover and the Settings preview (NP-DISC-001, NP-DISC-004, NP-DISC-005), as a
 * pure function: a library, a play log and an algorithm give one order, and the same inputs give it
 * again. The configs below are the engine's defaults and the two built-ins the shell ships, copied so
 * a change to either is a change to this test on purpose.
 */
import { describe, expect, it } from 'vitest';
import { colorTaken, describeAlgorithm, effectiveWeights, factorAvailability, nextColor, normalizeColor, rankSongs, type RankConfig, type RankPlay, type RankSong } from '../../src/shell/recommend/rank.js';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 864e5;

function defaults(): RankConfig {
  return {
    ranking: { tasteMatch: 0.3, artistAffinity: 0.2, genreAffinity: 0.15, collaborative: 0.1, recency: 0.1, popularityFit: 0.05, moodContext: 0.05, discoveryBonus: 0.05 },
    explorationRate: 0.1,
    decay: { halfLifeDays: 45 },
    penalties: { repeat: 0.35, repeatWindowDays: 7, excludeRecentlyPlayed: true, skip: 0.15, skipMax: 0.45, overexposure: 0.1, overexposureMax: 0.4 },
    skipThresholds: { immediateFraction: 0.1, immediateSeconds: 10 },
    diversity: { maxPerArtist: 2, maxPerArtistLargeList: 3, largeListThreshold: 40, tiers: { strong: 0.4, related: 0.3, emerging: 0.2, experimental: 0.1 }, strongArtistAffinity: 0.35, knownGenreAffinity: 0.2 },
    candidates: { newReleaseYears: 1 },
    modes: {
      'for-you': { multipliers: {}, tiers: null, popularityInverted: false, excludeOwned: false, excludeKnownArtists: false, excludeTopArtists: false },
      playlist: { multipliers: { moodContext: 3 }, tiers: { strong: 0.3, related: 0.4, emerging: 0.2, experimental: 0.1 }, popularityInverted: false, excludeOwned: false, excludeKnownArtists: false, excludeTopArtists: false },
      deep: { multipliers: { discoveryBonus: 3 }, tiers: { strong: 0, related: 0.1, emerging: 0.45, experimental: 0.45 }, popularityInverted: true, excludeOwned: true, excludeKnownArtists: true, excludeTopArtists: true },
    },
  };
}

/** Crate digger, as the shell ships it. */
function crateDigger(): RankConfig {
  const c = defaults();
  c.ranking = { tasteMatch: 0.25, artistAffinity: 0.05, genreAffinity: 0.15, collaborative: 0.15, recency: 0.05, popularityFit: 0, moodContext: 0.05, discoveryBonus: 0.3 };
  c.diversity.tiers = { strong: 0.1, related: 0.3, emerging: 0.35, experimental: 0.25 };
  c.explorationRate = 0.3;
  c.decay.halfLifeDays = 90;
  return c;
}

/** Eight songs across three artists and three genres, added a month ago, some with a tempo. */
const SONGS: RankSong[] = [
  { id: 's1', title: 'Harbour Morning', artist: 'Alder Quartet', genre: 'Jazz', bpm: 92, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's2', title: 'Gantry', artist: 'Alder Quartet', genre: 'Jazz', bpm: 96, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's3', title: 'Blue Hour', artist: 'Alder Quartet', genre: 'Jazz', bpm: 88, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's4', title: 'Tideline', artist: 'Birch Ensemble', genre: 'Folk', bpm: 120, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's5', title: 'Paper Harbour', artist: 'Birch Ensemble', genre: 'Folk', bpm: 124, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's6', title: 'Closing Hour', artist: 'Cedar Trio', genre: 'Electronic', bpm: 128, added: new Date(NOW - 30 * DAY).toISOString() },
  { id: 's7', title: 'Ember Line', artist: 'Cedar Trio', genre: 'Electronic', bpm: 132, added: new Date(NOW - 2 * DAY).toISOString(), date: '2026-10-01' },
  { id: 's8', title: 'Slow Carousel', artist: 'Cedar Trio', genre: 'Electronic', bpm: null, added: new Date(NOW - 30 * DAY).toISOString() },
];

/** Alder Quartet played a lot a month ago (outside the repeat window), Birch once, Cedar never. */
const PLAYS: RankPlay[] = [
  ...[0, 1, 2, 3, 4].map((i) => ({ id: 's1', at: NOW - (20 + i) * DAY, secs: 200, dur: 200, end: true })),
  ...[0, 1, 2].map((i) => ({ id: 's2', at: NOW - (15 + i) * DAY, secs: 200, dur: 200, end: true })),
  { id: 's3', at: NOW - 14 * DAY, secs: 200, dur: 200, end: true },
  { id: 's4', at: NOW - 12 * DAY, secs: 200, dur: 200, end: true },
];

const order = (ids: { song: RankSong }[]) => ids.map((r) => r.song.id);

describe('the ranker', () => {
  it('gives the same order for the same library, log, config and seed, and another for another seed', () => {
    const a = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 7, now: NOW });
    const b = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 7, now: NOW });
    expect(order(a.rows)).toEqual(order(b.rows));
    expect(a.rows).toHaveLength(8);
    expect(a.eligible).toBe(8);
    const seeds = new Set([1, 2, 3, 4, 5, 6].map((seed) => order(rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed, now: NOW }).rows).join()));
    expect(seeds.size, 'exploration is the only thing a seed moves, and it moves something').toBeGreaterThan(1);
  });

  it('Airwave default leans on the artists you play; Crate digger puts the least-played first', () => {
    const def = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 0, now: NOW });
    const dig = rankSongs({ songs: SONGS, plays: PLAYS, cfg: crateDigger(), mode: 'deep', seed: 0, now: NOW });
    const unplayed = ['s5', 's6', 's7', 's8'];
    const rankOf = (rows: { song: RankSong }[], id: string) => order(rows).indexOf(id);
    // Deep mode leaves out the artists you know (Alder, Birch), so Crate digger's list is Cedar Trio alone.
    expect(order(dig.rows).every((id) => ['s6', 's7', 's8'].includes(id)), 'deep: known artists are cut').toBe(true);
    // Under the default, the strong tier (Alder Quartet) opens the list; Cedar's unplayed songs sit lower.
    expect(def.rows[0]!.tier).toBe('strong');
    const meanDef = unplayed.filter((id) => rankOf(def.rows, id) >= 0).reduce((a, id) => a + rankOf(def.rows, id), 0) / 4;
    const meanDig = ['s6', 's7', 's8'].reduce((a, id) => a + rankOf(dig.rows, id), 0) / 3;
    expect(meanDig, 'the least-played rank higher under Crate digger').toBeLessThan(meanDef);
    expect(dig.rows.every((r) => r.parts.discoveryBonus > 0), 'and discovery is what carries them').toBe(true);
  });

  it('leaves out starred songs, queued songs and anything played inside the repeat window', () => {
    const recent: RankPlay[] = [...PLAYS, { id: 's6', at: NOW - DAY, secs: 200, dur: 200, end: true }];
    const r = rankSongs({ songs: SONGS, plays: recent, starred: ['s7'], queued: ['s8'], cfg: defaults(), mode: 'for-you', seed: 0, now: NOW });
    expect(order(r.rows)).not.toContain('s7');
    expect(order(r.rows)).not.toContain('s8');
    expect(order(r.rows), 'excludeRecentlyPlayed removes it rather than penalising it').not.toContain('s6');
    expect(r.eligible, 'eligible counts what could be shown, before the mode and the window cut').toBe(6);
    const cfg = defaults();
    cfg.penalties.excludeRecentlyPlayed = false;
    const kept = rankSongs({ songs: SONGS, plays: recent, cfg, mode: 'for-you', seed: 0, now: NOW });
    const s6 = kept.rows.find((x) => x.song.id === 's6')!;
    expect(s6.pen, 'with the exclusion off, the repeat penalty applies instead').toBeCloseTo(0.35, 5);
    expect(s6.score).toBeLessThan(s6.raw);
  });

  it('a refresh excludes what was already shown, and says how many were eligible', () => {
    const first = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 1, now: NOW });
    const shown = order(first.rows).slice(0, 5);
    const next = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 2, exclude: shown, now: NOW });
    expect(order(next.rows)).toHaveLength(3);
    expect(order(next.rows).some((id) => shown.includes(id))).toBe(false);
    expect(next.eligible).toBe(8);
    const none = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 3, exclude: order(first.rows), now: NOW });
    expect(none.rows, 'once everything has been shown there is nothing left — the shell starts over').toHaveLength(0);
  });

  it('a genre lean moves that genre up without touching the saved weights', () => {
    const cfg = defaults();
    cfg.explorationRate = 0; // so the only thing moving a row is the lean
    const plain = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW });
    const lean = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW, lean: { genre: 'Electronic' } });
    const meanRank = (rows: { song: RankSong }[]) => ['s6', 's7', 's8'].reduce((a, id) => a + order(rows).indexOf(id), 0) / 3;
    const bestRank = (rows: { song: RankSong }[]) => Math.min(...['s6', 's7', 's8'].map((id) => order(rows).indexOf(id)));
    expect(meanRank(lean.rows), 'Electronic sits no lower on average').toBeLessThanOrEqual(meanRank(plain.rows));
    expect(bestRank(lean.rows), 'and its best song climbs').toBeLessThan(bestRank(plain.rows));
    const scoreOf = (rows: { song: RankSong; score: number }[], id: string) => rows.find((r) => r.song.id === id)!.score;
    for (const id of ['s6', 's7', 's8']) expect(scoreOf(lean.rows, id), `${id} scores higher under the lean`).toBeGreaterThan(scoreOf(plain.rows, id));
    expect(lean.rows.filter((r) => r.song.genre === 'Electronic').every((r) => r.parts.genreAffinity > 0 && r.tier === 'emerging'), 'a leaned genre is a known genre: emerging, not experimental').toBe(true);
    expect(cfg.ranking.genreAffinity, 'the config is read, never written').toBe(0.15);
    expect(effectiveWeights(cfg, 'for-you', { genre: 'Electronic' }).genreAffinity).toBeGreaterThan(effectiveWeights(cfg, 'for-you', null).genreAffinity);
  });

  it('Familiar and Adventurous bend exploration and discovery, Balanced leaves the algorithm alone', () => {
    const cfg = defaults();
    const balanced = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW, lean: { explore: 'balanced' } });
    const none = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW });
    expect(order(balanced.rows)).toEqual(order(none.rows));
    const familiar = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW, lean: { explore: 'familiar' } });
    const adventurous = rankSongs({ songs: SONGS, plays: PLAYS, cfg, mode: 'for-you', seed: 0, now: NOW, lean: { explore: 'adventurous' } });
    expect(familiar.explorationRate).toBeLessThan(none.explorationRate);
    expect(adventurous.explorationRate).toBeGreaterThan(none.explorationRate);
    expect(adventurous.weights.discoveryBonus).toBeGreaterThan(none.weights.discoveryBonus);
    expect(familiar.weights.artistAffinity).toBeGreaterThan(none.weights.artistAffinity);
  });

  it('reads tempo, genre, release and added dates, and says which factors this library can feed', () => {
    const r = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 0, now: NOW });
    const s7 = r.rows.find((x) => x.song.id === 's7')!;
    const s6 = r.rows.find((x) => x.song.id === 's6')!;
    expect(s7.parts.recency, 'released last week and added two days ago: fresher than its album mate').toBeGreaterThan(s6.parts.recency);
    expect(s6.parts.tasteMatch, 'tempo and genre both score').toBeGreaterThan(0);
    const avail = factorAvailability(SONGS, PLAYS);
    expect(avail.genreAffinity.has).toBe(true);
    expect(avail.tasteMatch.note).toContain('tempo proximity and genre');
    expect(avail.collaborative.has).toBe(false);
    const bare = factorAvailability(SONGS.map((s) => ({ id: s.id, title: s.title, artist: s.artist })), []);
    expect(bare.genreAffinity.has).toBe(false);
    expect(bare.recency.has).toBe(false);
    expect(bare.tasteMatch.has).toBe(false);
  });

  it('caps an artist and mixes the tiers, dropping nothing', () => {
    const r = rankSongs({ songs: SONGS, plays: PLAYS, cfg: defaults(), mode: 'for-you', seed: 0, now: NOW });
    const firstFour = r.rows.slice(0, 4).map((x) => x.song.artist);
    expect(firstFour.filter((a) => a === 'Alder Quartet').length, 'maxPerArtist 2 holds in the head of the list').toBeLessThanOrEqual(2);
    expect(new Set(order(r.rows)).size).toBe(8);
  });

  it('describes an algorithm from its largest weights and its exploration', () => {
    expect(describeAlgorithm(defaults(), 'for-you')).toBe('Favours what sounds like what you play and artists you play most, little exploration');
    expect(describeAlgorithm(crateDigger(), 'deep')).toBe('Favours what you have heard least and what sounds like what you play, wide exploration');
  });
});

describe('algorithm colours', () => {
  const PALETTE = ['#c8403a', '#d4782a', '#b8961e', '#7ca02a', '#3a9a5e', '#1f9a8f', '#1d8fb8', '#2f61c1', '#5c55c9', '#8a4fc2', '#b9459b', '#c94f6d'];

  it('hands out the next unused hue, never one another algorithm has', () => {
    expect(nextColor([], PALETTE)).toBe('#c8403a');
    expect(nextColor(['#C8403A', '#d4782a'], PALETTE)).toBe('#b8961e');
    expect(nextColor(['#2f61c1', '#5c55c9', '#d4782a'], PALETTE)).toBe('#c8403a');
    const used: string[] = [];
    for (let i = 0; i < 12; i += 1) used.push(nextColor(used, PALETTE));
    expect(new Set(used).size, 'twelve algorithms, twelve colours').toBe(12);
  });

  it('with all twelve taken, picks the least crowded hue, farthest from the others', () => {
    const all = PALETTE.slice();
    const thirteenth = nextColor(all, PALETTE);
    expect(PALETTE).toContain(thirteenth);
    const twice = nextColor([...all, thirteenth], PALETTE);
    expect(twice, 'the next one avoids the hue just doubled').not.toBe(thirteenth);
  });

  it('normalises and checks a colour', () => {
    expect(normalizeColor(' #2F61C1 ')).toBe('#2f61c1');
    expect(normalizeColor('2f61c1')).toBe('#2f61c1');
    expect(normalizeColor('blue')).toBeNull();
    expect(normalizeColor(12)).toBeNull();
    expect(colorTaken('#2F61C1', ['#2f61c1'])).toBe(true);
    expect(colorTaken('#2f61c2', ['#2f61c1'])).toBe(false);
  });
});
