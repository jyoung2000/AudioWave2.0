/**
 * Discover's online candidates (NP-DISC-006): queries come from the ranker's own profile of the play
 * log, rows are scored by the same `rankSongs` the local Discover uses, and the explanation names the
 * factor that actually put a row there. The config is the engine's default, copied here so a change
 * to it is a change to this test on purpose — the same convention `recommend-rank.test.ts` follows.
 */
import { describe, expect, it } from 'vitest';
import {
  explainFound,
  identityKey,
  onlineQueries,
  rankFound,
  toRankSong,
  type FoundRow,
  type GatheredRow,
} from '../../src/shell/recommend/online.js';
import type { RankConfig, RankPlay, RankSong } from '../../src/shell/recommend/rank.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

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
      playlist: { multipliers: { moodContext: 3 }, tiers: null, popularityInverted: false, excludeOwned: false, excludeKnownArtists: false, excludeTopArtists: false },
      deep: { multipliers: { discoveryBonus: 3 }, tiers: null, popularityInverted: true, excludeOwned: true, excludeKnownArtists: true, excludeTopArtists: true },
    },
  };
}

/** Three songs, two artists, two genres. */
const LIB: RankSong[] = [
  { id: 'l1', title: 'Harbour Morning', artist: 'Alder Quartet', genre: 'Jazz', bpm: 92 },
  { id: 'l2', title: 'Gantry', artist: 'Alder Quartet', genre: 'Jazz', bpm: 96 },
  { id: 'l3', title: 'Tideline', artist: 'Birch Ensemble', genre: 'Folk', bpm: 120 },
];

/** Alder Quartet played four times, Birch once. */
const PLAYS: RankPlay[] = [
  { id: 'l1', at: NOW - 3 * 864e5, secs: 200, dur: 200, end: true },
  { id: 'l1', at: NOW - 2 * 864e5, secs: 200, dur: 200, end: true },
  { id: 'l1', at: NOW - 864e5, secs: 200, dur: 200, end: true },
  { id: 'l2', at: NOW - 2 * 864e5, secs: 200, dur: 200, end: true },
  { id: 'l3', at: NOW - 864e5, secs: 200, dur: 200, end: true },
];

const row = (over: Partial<FoundRow> = {}): FoundRow => ({
  t: 'Some Song',
  a: 'Some Artist',
  al: '',
  d: 210,
  bpm: null,
  p: 'youtube',
  u: 'https://youtu.be/abc',
  ...over,
});

const gathered = (rows: FoundRow[], asked = onlineQueries(LIB, PLAYS, defaults(), { artists: 1 })[0]!): GatheredRow[] =>
  rows.map((r) => ({ row: r, asked }));

describe('the searches Discover asks for', () => {
  it('asks for the artists and genres actually played, most played first', () => {
    const q = onlineQueries(LIB, PLAYS, defaults(), { artists: 2, genres: 2 });
    expect(q.map((x) => x.q)).toEqual(['alder quartet', 'birch ensemble', 'jazz', 'folk']);
    expect(q.map((x) => x.kind)).toEqual(['artist', 'artist', 'genre', 'genre']);
    expect(q[0]!.weight).toBe(4);
    expect(q[1]!.weight).toBe(1);
  });

  it('asks a session lean first, and never asks the same word twice', () => {
    const q = onlineQueries(LIB, PLAYS, defaults(), { leanGenre: 'Jazz', artists: 1, genres: 2 });
    // The lean is the person's own request; then the log, most played first.
    expect(q.map((x) => x.q)).toEqual(['Jazz', 'alder quartet', 'folk']);
    // "Jazz" was asked as a lean and never again as a genre.
    expect(q.filter((x) => x.q.toLowerCase() === 'jazz')).toHaveLength(1);
  });

  it('follows a mode that leaves out the artists you know: it asks for genres instead', () => {
    const q = onlineQueries(LIB, PLAYS, defaults(), { mode: 'deep', artists: 2, genres: 1 });
    expect(q.map((x) => x.kind)).toEqual(['genre', 'genre']);
    expect(q.map((x) => x.q)).toEqual(['jazz', 'folk']);
  });

  it('carries the genre only when the query was a genre', () => {
    const artistQuery = onlineQueries(LIB, PLAYS, defaults(), { artists: 1, genres: 0 })[0]!;
    const genreQuery = onlineQueries(LIB, PLAYS, defaults(), { artists: 0, genres: 1 })[0]!;
    expect(artistQuery.genre).toBeNull();
    expect(genreQuery.genre).toBe('jazz');
  });

  it('asks nothing when nothing has been played', () => {
    expect(onlineQueries(LIB, [], defaults())).toEqual([]);
  });
});

describe('a found row as the ranker sees it', () => {
  it('takes its id from the address, and keeps the album only when there is one', () => {
    const withAlbum = toRankSong({ row: row({ al: 'Copper Meridian' }), asked: onlineQueries(LIB, PLAYS, defaults())[0]! });
    expect(withAlbum.id).toBe('https://youtu.be/abc');
    expect(withAlbum.album).toBe('Copper Meridian');

    const without = toRankSong({ row: row({ al: '   ' }), asked: onlineQueries(LIB, PLAYS, defaults())[0]! });
    expect(without).not.toHaveProperty('album');
  });

  it('never invents a date, an added time or a like, and treats an unmeasured tempo as none', () => {
    const song = toRankSong({ row: row({ bpm: 0 }), asked: onlineQueries(LIB, PLAYS, defaults())[0]! });
    expect(song.bpm).toBeNull();
    expect(song.date).toBeNull();
    expect(song.added).toBeNull();
    expect(song.liked).toBe(false);
  });

  it('falls back to a keyed id when the row has no address', () => {
    const g = { row: row({ u: null, t: 'Ember Line', a: 'Cedar Trio' }), asked: onlineQueries(LIB, PLAYS, defaults())[0]! };
    expect(toRankSong(g).id).toBe(`found:${identityKey('Ember Line', 'Cedar Trio')}`);
  });
});

describe('ranking found rows with the listener algorithm', () => {
  it('drops what this device already has, however the two spell it', () => {
    const { picks, diagnostics } = rankFound({
      gathered: gathered([row({ t: 'Harbour Morning!', a: 'alder quartet', u: 'https://youtu.be/owned' })]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    expect(picks).toHaveLength(0);
    expect(diagnostics.arrived).toBe(1);
    expect(diagnostics.fresh).toBe(0);
  });

  it('counts one recording once when two platforms offer it, and keeps both facts', () => {
    const same = { t: 'Ember Line', a: 'Cedar Trio', al: '', d: 200, bpm: null, p: 'youtube', u: 'https://youtu.be/same' };
    const { picks, diagnostics } = rankFound({
      gathered: gathered([{ ...same }, { ...same }]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    expect(picks).toHaveLength(1);
    expect(diagnostics.fresh).toBe(1);
    expect(picks[0]!.platform).toBe('youtube');
    expect(picks[0]!.url).toBe('https://youtu.be/same');
  });

  it('puts an artist you play above one you have never played', () => {
    const { picks } = rankFound({
      gathered: gathered([
        row({ t: 'Unknown Thing', a: 'Nobody At All', u: 'https://youtu.be/nothing', p: 'soundcloud' }),
        row({ t: 'New Alder Song', a: 'Alder Quartet', u: 'https://youtu.be/alder', p: 'youtube' }),
      ]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      seed: 0,
      now: NOW,
    });
    expect(picks.map((p) => p.song.title)).toEqual(['New Alder Song', 'Unknown Thing']);
    const alder = picks[0]!.row;
    expect(alder.parts.artistAffinity).toBeGreaterThan(0);
  });

  it('lets a genre query feed the genre factor, which a bare row could never do', () => {
    const jazz = onlineQueries(LIB, PLAYS, defaults(), { artists: 0, genres: 1 })[0]!;
    const { picks } = rankFound({
      gathered: [{ row: row({ t: 'Something New', a: 'Someone Else', u: 'https://youtu.be/jazz' }), asked: jazz }],
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    expect(jazz.genre).toBe('jazz');
    expect(picks[0]!.row.parts.genreAffinity).toBeGreaterThan(0);
  });

  it('ranks under the mode chosen, never another: Deep cuts keeps only artists you have never played', () => {
    const { picks, diagnostics } = rankFound({
      gathered: gathered([
        row({ t: 'New Alder Song', a: 'Alder Quartet', u: 'https://youtu.be/alder' }),
        row({ t: 'Unknown Thing', a: 'Nobody At All', u: 'https://youtu.be/nobody' }),
      ]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'deep',
      now: NOW,
    });
    expect(diagnostics.mode).toBe('deep');
    expect(picks.map((p) => p.song.title)).toEqual(['Unknown Thing']);
    expect(diagnostics.ranked).toBe(1);
  });

  it('keeps the catalog’s own genre and the preview on the pick', () => {
    const { picks } = rankFound({
      gathered: gathered([row({ t: 'Quiet Pier', a: 'Someone Else', u: 'https://youtu.be/pier', g: 'Jazz', c: 'https://clips.example/pier.m4a' })]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    expect(picks[0]!.song.genre).toBe('Jazz');
    expect(picks[0]!.preview).toBe('https://clips.example/pier.m4a');
    expect(picks[0]!.row.parts.genreAffinity).toBeGreaterThan(0);
  });

  it('counts one recording once even when two copies have different addresses, and hands back what the caller attached', () => {
    const asked = onlineQueries(LIB, PLAYS, defaults())[0]!;
    const extra = { catalogId: 'deezer:1' };
    const { picks } = rankFound({
      gathered: [
        { row: row({ t: 'Ember Line', a: 'Cedar Trio', u: 'https://youtu.be/one' }), asked, extra },
        { row: row({ t: 'Ember Line', a: 'Cedar Trio', u: 'https://soundcloud.example/two' }), asked },
      ],
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]!.extra).toBe(extra);
  });

  it('leaves out what the caller has already chosen', () => {
    const { picks } = rankFound({
      gathered: gathered([row({ t: 'New Alder Song', a: 'Alder Quartet', u: 'https://youtu.be/alder' })]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      exclude: ['https://youtu.be/alder'],
      now: NOW,
    });
    expect(picks).toHaveLength(0);
  });
});

describe('what Discover says about an online pick', () => {
  it('names the factor that put it there and says it is not on this device yet', () => {
    const { picks } = rankFound({
      gathered: gathered([row({ t: 'New Alder Song', a: 'Alder Quartet', u: 'https://youtu.be/alder', p: 'youtube' })]),
      library: LIB,
      plays: PLAYS,
      cfg: defaults(),
      mode: 'for-you',
      now: NOW,
    });
    const said = explainFound(picks[0]!);
    expect(said).toContain('an artist you play');
    expect(said).toContain('found on youtube');
    expect(said).toContain('not on this device yet');
  });
});
