/**
 * The player's recommendation ranker, as a pure function (NP-DISC-001).
 *
 * One piece of arithmetic ranks two lists: Discover in the music list, and "What it picks now" beside
 * the sliders in Settings ▸ Recommendations. It takes the shell's own rows, play log and algorithm
 * config (the engine's shape: `ranking`, `modes`, `diversity`, `penalties`, `decay`, `explorationRate`)
 * and gives an order back, with every number that made it — so the preview can explain a row and a
 * test can check one.
 *
 * Deterministic: the only randomness (exploration picks) comes from a small seeded generator, so the
 * same library, log, config and seed always give the same order. Discover changes the seed on Refresh;
 * the preview and the mockup keep seed 0.
 *
 * Nothing here is fetched or guessed: a factor the library cannot measure scores zero and
 * `factorAvailability` says so, so the panel can say it beside the slider rather than leave a slider
 * that moves nothing.
 */

export type AlgoMode = 'for-you' | 'playlist' | 'genre' | 'similar' | 'deep' | 'new-releases' | 'recent';
export type Tier = 'strong' | 'related' | 'emerging' | 'experimental';
export type FactorKey = 'tasteMatch' | 'artistAffinity' | 'genreAffinity' | 'collaborative' | 'recency' | 'popularityFit' | 'moodContext' | 'discoveryBonus';

export const FACTOR_KEYS: readonly FactorKey[] = ['tasteMatch', 'artistAffinity', 'genreAffinity', 'collaborative', 'recency', 'popularityFit', 'moodContext', 'discoveryBonus'];
export const TIERS: readonly Tier[] = ['strong', 'related', 'emerging', 'experimental'];

/** A row as the shell holds it; only what the ranker reads. */
export interface RankSong {
  id: string;
  title: string;
  artist: string;
  album?: string;
  bpm?: number | null;
  genre?: string | null;
  /** Release date, `YYYY-MM-DD` / `YYYY-MM` / `YYYY`, when the tags or the catalog gave one. */
  date?: string | null;
  /** When the row reached this library (ISO), for "newest" when nothing has been played. */
  added?: string | null;
  liked?: boolean;
}

export interface RankPlay {
  id: string;
  at: number;
  secs?: number;
  dur?: number;
  end?: boolean;
  via?: string;
}

/** The engine's config, as far as the ranker reads it. */
export interface RankConfig {
  ranking: Record<FactorKey, number>;
  explorationRate: number;
  decay: { halfLifeDays: number };
  penalties: { repeat: number; repeatWindowDays: number; excludeRecentlyPlayed: boolean; skip: number; skipMax: number; overexposure: number; overexposureMax: number };
  skipThresholds: { immediateFraction: number; immediateSeconds: number };
  diversity: { maxPerArtist: number; maxPerArtistLargeList: number; largeListThreshold: number; tiers: Record<Tier, number>; strongArtistAffinity: number; knownGenreAffinity: number };
  candidates: { newReleaseYears: number };
  modes: Record<string, { multipliers: Partial<Record<FactorKey, number>>; tiers: Record<Tier, number> | null; popularityInverted: boolean; excludeOwned: boolean; excludeKnownArtists: boolean; excludeTopArtists: boolean }>;
}

/** A session lean (NP-DISC-005): bias the ranking without editing the saved algorithm. */
export type LeanExplore = 'familiar' | 'balanced' | 'adventurous';
export interface RankLean {
  explore?: LeanExplore | null;
  genre?: string | null;
}

export interface RankInput {
  songs: readonly RankSong[];
  plays: readonly RankPlay[];
  /** Ids the person starred: known, so not recommended. */
  starred?: readonly string[];
  /** Ids waiting in Up Next: already chosen, so not recommended. */
  queued?: readonly string[];
  /** What Discover has shown, for the overexposure penalty (`{id, at}` as the shelf logs it). */
  shown?: readonly { id: string; at: number }[];
  /** Ids to leave out altogether (what this Discover session already showed). */
  exclude?: readonly string[];
  cfg: RankConfig;
  mode: AlgoMode | string;
  seed?: number;
  lean?: RankLean | null;
  now?: number;
}

export interface RankRow {
  song: RankSong;
  /** The score after penalties, 0..1. */
  score: number;
  /** Before penalties. */
  raw: number;
  /** Each factor's contribution to `raw`. */
  parts: Record<FactorKey, number>;
  /** Each factor's share of the weights — the most it could have given. */
  share: Record<FactorKey, number>;
  /** The penalty fraction taken off, 0..1. */
  pen: number;
  tier: Tier;
  /** Put here by exploration rather than by its score. */
  explored: boolean;
}

export interface RankResult {
  rows: RankRow[];
  /** How many rows were eligible before `exclude` and the mode's cuts. */
  eligible: number;
  /** The effective weights after the mode and the lean, normalised. */
  weights: Record<FactorKey, number>;
  explorationRate: number;
}

const DAY = 864e5;

/** mulberry32: small, seedable, good enough to pick an exploration row. */
export function seeded(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lower(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase();
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` to a time, or null. */
function dateMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(s));
  if (!m) return null;
  const t = Date.UTC(+m[1]!, m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1);
  return Number.isFinite(t) ? t : null;
}

export interface ListenerProfile {
  total: number;
  counts: Record<string, number>;
  maxCount: number;
  artistPlays: Record<string, number>;
  genrePlays: Record<string, number>;
  avgBpm: number;
  lastAt: Record<string, number>;
  skips: Record<string, number>;
  topArtist: string | null;
}

/** What the log says about the listener: counts, artists, genres, tempo, last plays, skips. */
export function profile(songs: readonly RankSong[], plays: readonly RankPlay[], cfg: RankConfig): ListenerProfile {
  const byId = new Map<string, RankSong>();
  for (const s of songs) byId.set(s.id, s);
  const counts: Record<string, number> = {};
  const artistPlays: Record<string, number> = {};
  const genrePlays: Record<string, number> = {};
  const lastAt: Record<string, number> = {};
  const skips: Record<string, number> = {};
  let tempoSum = 0;
  let tempoN = 0;
  let maxCount = 0;
  for (const r of plays) {
    counts[r.id] = (counts[r.id] ?? 0) + 1;
    if (counts[r.id]! > maxCount) maxCount = counts[r.id]!;
    if (!(r.id in lastAt) || r.at > lastAt[r.id]!) lastAt[r.id] = r.at;
    const sg = byId.get(r.id);
    if (!sg) continue;
    const artist = lower(sg.artist);
    if (artist) artistPlays[artist] = (artistPlays[artist] ?? 0) + 1;
    const genre = lower(sg.genre);
    if (genre) genrePlays[genre] = (genrePlays[genre] ?? 0) + 1;
    if (sg.bpm) {
      tempoSum += sg.bpm;
      tempoN += 1;
    }
    if (typeof r.secs === 'number') {
      const len = r.dur ?? 0;
      const immediate = r.secs < cfg.skipThresholds.immediateSeconds || (len > 0 && r.secs < len * cfg.skipThresholds.immediateFraction);
      if (immediate && !r.end) skips[r.id] = (skips[r.id] ?? 0) + 1;
    }
  }
  let topArtist: string | null = null;
  for (const a of Object.keys(artistPlays)) if (topArtist === null || artistPlays[a]! > artistPlays[topArtist]!) topArtist = a;
  return { total: plays.length, counts, maxCount, artistPlays, genrePlays, avgBpm: tempoN ? tempoSum / tempoN : 0, lastAt, skips, topArtist };
}

/** Which factors this library can feed at all, and why not when it cannot. */
export function factorAvailability(songs: readonly RankSong[], plays: readonly RankPlay[]): Record<FactorKey, { has: boolean; note: string }> {
  const anyBpm = songs.some((s) => !!s.bpm);
  const anyGenre = songs.some((s) => !!lower(s.genre));
  const anyDate = songs.some((s) => !!s.date || !!s.added);
  const genres = new Set(songs.map((s) => lower(s.genre)).filter(Boolean)).size;
  return {
    tasteMatch: {
      has: anyBpm || anyGenre,
      note: anyBpm && anyGenre ? 'Here: tempo proximity and genre.' : anyBpm ? 'Here: tempo proximity only — these songs carry no genre.' : anyGenre ? 'Here: genre only — these songs carry no tempo.' : 'No tempo or genre on these songs yet — the companion app and the catalog supply them.',
    },
    artistAffinity: { has: plays.length > 0, note: plays.length ? '' : 'Nothing played yet.' },
    genreAffinity: { has: anyGenre && plays.length > 0, note: anyGenre ? (plays.length ? `${genres} genre${genres === 1 ? '' : 's'} in this library.` : 'Genres are here; nothing played yet.') : 'No genre on these songs — the companion app and the catalog supply it.' },
    collaborative: { has: false, note: 'Needs other listeners; this page has one.' },
    recency: { has: plays.length > 0 || anyDate, note: anyDate ? 'Here: release and added dates, and your last play.' : 'Here: your last play only.' },
    popularityFit: { has: false, note: 'No play counts beyond your own to compare against.' },
    moodContext: { has: false, note: 'No mood tags on these songs.' },
    discoveryBonus: { has: true, note: '' },
  };
}

/** The effective, normalised weights: the algorithm's, times the mode's multipliers, times the lean. */
export function effectiveWeights(cfg: RankConfig, mode: string, lean?: RankLean | null): Record<FactorKey, number> {
  const mult = cfg.modes[mode]?.multipliers ?? {};
  const out = {} as Record<FactorKey, number>;
  let sum = 0;
  for (const k of FACTOR_KEYS) {
    let w = (cfg.ranking[k] ?? 0) * (mult[k] === undefined ? 1 : mult[k]!);
    if (lean?.explore === 'familiar') {
      if (k === 'discoveryBonus') w *= 0.5;
      if (k === 'artistAffinity' || k === 'genreAffinity') w *= 1.5;
    } else if (lean?.explore === 'adventurous') {
      if (k === 'discoveryBonus') w *= 2;
      if (k === 'artistAffinity') w *= 0.5;
    }
    if (lean?.genre && k === 'genreAffinity') w = Math.max(w * 3, 0.3);
    out[k] = w;
    sum += w;
  }
  if (!sum) sum = 1;
  for (const k of FACTOR_KEYS) out[k] = out[k]! / sum;
  return out;
}

/** The exploration rate after the lean. */
export function effectiveExploration(cfg: RankConfig, lean?: RankLean | null): number {
  const base = Math.max(0, Math.min(0.5, cfg.explorationRate || 0));
  if (lean?.explore === 'familiar') return Math.min(base, 0.02);
  if (lean?.explore === 'adventurous') return Math.max(base * 2.5, 0.3);
  return base;
}

/**
 * Rank the songs. The order is: score (weighted factors, less penalties), then the familiarity mix
 * (each tier's share of the list, the mode's or the algorithm's), then the artist cap, then exploration.
 */
export function rankSongs(input: RankInput): RankResult {
  const cfg = input.cfg;
  const mode = cfg.modes[input.mode] ? input.mode : 'for-you';
  const m = cfg.modes[mode]!;
  const now = input.now ?? Date.now();
  const lean = input.lean ?? null;
  const starred = new Set(input.starred ?? []);
  const queued = new Set(input.queued ?? []);
  const excluded = new Set(input.exclude ?? []);
  const p = profile(input.songs, input.plays, cfg);
  const weights = effectiveWeights(cfg, mode, lean);
  const explorationRate = effectiveExploration(cfg, lean);

  const half = Math.max(1, cfg.decay.halfLifeDays) * DAY;
  const repeatWindow = cfg.penalties.repeatWindowDays * DAY;
  const releaseSpan = Math.max(1, cfg.candidates.newReleaseYears) * 365 * DAY;
  const totalGenre = Object.values(p.genrePlays).reduce((a, b) => a + b, 0);
  const leanGenre = lower(lean?.genre);
  const impressions: Record<string, number> = {};
  for (const s of input.shown ?? []) impressions[s.id] = (impressions[s.id] ?? 0) + 1;

  const candidates = input.songs.filter((s) => !starred.has(s.id) && !queued.has(s.id));
  const eligible = candidates.length;

  const scored: RankRow[] = [];
  for (const sg of candidates) {
    if (excluded.has(sg.id)) continue;
    const artist = lower(sg.artist);
    const genre = lower(sg.genre);
    const n = p.counts[sg.id] ?? 0;
    const artistShare = p.total ? (p.artistPlays[artist] ?? 0) / p.total : 0;
    const genreShare = totalGenre && genre ? (p.genrePlays[genre] ?? 0) / totalGenre : 0;

    // Taste: tempo proximity and genre share, whichever the song carries (the mean of what is there).
    const tasteParts: number[] = [];
    if (p.avgBpm && sg.bpm) tasteParts.push(Math.max(0, 1 - Math.abs(sg.bpm - p.avgBpm) / (p.avgBpm * 0.5)));
    if (genre && totalGenre) tasteParts.push(genreShare);
    const tasteMatch = tasteParts.length ? tasteParts.reduce((a, b) => a + b, 0) / tasteParts.length : 0;

    // Recency: the last play, the release date or the day it was added — whichever is freshest.
    const last = p.lastAt[sg.id];
    let recency = last ? Math.pow(0.5, Math.max(0, now - last) / half) : 0;
    const released = dateMs(sg.date);
    if (released !== null) recency = Math.max(recency, Math.max(0, 1 - Math.max(0, now - released) / releaseSpan));
    const added = sg.added ? Date.parse(sg.added) : NaN;
    if (Number.isFinite(added)) recency = Math.max(recency, Math.pow(0.5, Math.max(0, now - added) / half));

    // Discovery pulls against your own play count. The mode's `popularityInverted` reads *popularity*
    // upside down, and this library has no popularity to read (popularityFit is 0 for everyone), so
    // the flag has nothing to invert here — discovery stays "what you have heard least".
    const discoveryBonus = p.maxCount ? 1 - n / p.maxCount : 1;

    const f: Record<FactorKey, number> = {
      tasteMatch,
      artistAffinity: artistShare,
      genreAffinity: leanGenre && genre === leanGenre ? 1 : genreShare,
      collaborative: 0,
      recency,
      popularityFit: 0,
      moodContext: 0,
      discoveryBonus,
    };

    // The mode's cuts (the engine's exclusions). `excludeOwned` is not applied: everything in this
    // library is owned, so it would empty the list — recorded in design/decisions.md (NPD-032).
    const known = (p.artistPlays[artist] ?? 0) > 0;
    if (m.excludeTopArtists && p.topArtist !== null && artist === p.topArtist) continue;
    if (m.excludeKnownArtists && known) continue;
    const recentlyPlayed = !!last && now - last < repeatWindow;
    if (recentlyPlayed && cfg.penalties.excludeRecentlyPlayed) continue;

    // Penalties, after the score is built, in the engine's order: repeat, skips, impressions.
    let pen = 0;
    if (recentlyPlayed) pen += cfg.penalties.repeat;
    pen += Math.min(cfg.penalties.skipMax, (p.skips[sg.id] ?? 0) * cfg.penalties.skip);
    pen += Math.min(cfg.penalties.overexposureMax, (impressions[sg.id] ?? 0) * cfg.penalties.overexposure);
    pen = Math.min(1, pen);

    const parts = {} as Record<FactorKey, number>;
    let raw = 0;
    for (const k of FACTOR_KEYS) {
      parts[k] = f[k] * weights[k];
      raw += parts[k];
    }
    const score = Math.max(0, raw * (1 - pen));
    // A genre leaned toward counts as a known genre: its unplayed artists are "emerging", not "experimental".
    const knownGenre = genreShare >= cfg.diversity.knownGenreAffinity || (!!leanGenre && genre === leanGenre);
    const tier: Tier = artistShare >= cfg.diversity.strongArtistAffinity ? 'strong' : known ? 'related' : knownGenre ? 'emerging' : 'experimental';
    scored.push({ song: sg, score, raw, parts, share: weights, pen, tier, explored: false });
  }

  scored.sort((x, y) => y.score - x.score || x.song.title.localeCompare(y.song.title) || x.song.id.localeCompare(y.song.id));

  const rows = mix(scored, leanedTiers(m.tiers ?? cfg.diversity.tiers, lean), cfg);
  explore(rows, explorationRate, seeded(input.seed ?? 0));
  return { rows, eligible, weights, explorationRate };
}

/**
 * The familiarity mix and the artist cap. Tiers are drawn in turn, each taking its share of the list
 * (the most under-filled tier with rows left goes next); an artist past its cap waits until every
 * other row has been placed. Nothing is dropped: a list with one tier in it is still that tier.
 */
function mix(scored: readonly RankRow[], shares: Record<Tier, number>, cfg: RankConfig): RankRow[] {
  const n = scored.length;
  if (n < 2) return scored.slice();
  const cap = n >= cfg.diversity.largeListThreshold ? cfg.diversity.maxPerArtistLargeList : cfg.diversity.maxPerArtist;
  const byTier: Record<Tier, RankRow[]> = { strong: [], related: [], emerging: [], experimental: [] };
  for (const r of scored) byTier[r.tier].push(r);
  const placed: Record<Tier, number> = { strong: 0, related: 0, emerging: 0, experimental: 0 };
  const perArtist: Record<string, number> = {};
  const held: RankRow[] = [];
  const out: RankRow[] = [];
  const total = TIERS.reduce((a, t) => a + Math.max(0, shares[t] || 0), 0) || 1;
  while (out.length + held.length < n) {
    // The tier furthest below its share, among those with rows left; a tier with no share is a last
    // resort. The share buys a place only for a row scoring at least half of the best one waiting:
    // the mix interleaves comparable rows, it does not lift a row the ranking all but dismissed over
    // one it favoured (a genre leaned toward stays ahead of the rest).
    let pick: Tier | null = null;
    let best = -Infinity;
    let top = 0;
    for (const t of TIERS) if (byTier[t].length) top = Math.max(top, byTier[t][0]!.score);
    for (const t of TIERS) {
      if (!byTier[t].length) continue;
      if (byTier[t][0]!.score < top * 0.5) continue;
      const want = (Math.max(0, shares[t] || 0) / total) * n;
      const deficit = want - placed[t] + (want > 0 ? 0 : -n);
      if (deficit > best) {
        best = deficit;
        pick = t;
      }
    }
    if (pick === null) break;
    const r = byTier[pick].shift()!;
    placed[pick] += 1;
    const artist = lower(r.song.artist);
    if (cap > 0 && (perArtist[artist] ?? 0) >= cap) {
      held.push(r);
      continue;
    }
    perArtist[artist] = (perArtist[artist] ?? 0) + 1;
    out.push(r);
  }
  held.sort((x, y) => y.score - x.score || x.song.title.localeCompare(y.song.title));
  return out.concat(held);
}

/**
 * Exploration: `rate` of the slots (rounded, so eight songs at 0.1 still explore once) are spread
 * evenly down the list, and each is given a row from the lower half, chosen by the seed.
 */
function explore(rows: RankRow[], rate: number, random: () => number): void {
  const n = rows.length;
  if (!(rate > 0) || n < 4) return;
  const count = Math.min(Math.floor(n / 2), Math.round(rate * n));
  if (count < 1) return;
  const half = Math.floor(n / 2);
  for (let k = 0; k < count; k += 1) {
    const i = Math.min(half - 1, Math.floor((k + 0.5) * (half / count)));
    const from = half + Math.floor(random() * (n - half));
    if (from <= i || from >= n) continue;
    const [picked] = rows.splice(from, 1);
    if (!picked) continue;
    picked.explored = true;
    rows.splice(i, 0, picked);
  }
}

/** The tier shares after the lean: Familiar leans on the strong tier, Adventurous on the far ones. */
function leanedTiers(tiers: Record<Tier, number>, lean?: RankLean | null): Record<Tier, number> {
  const toward = lean?.explore === 'familiar' ? { strong: 0.5, related: 0.3, emerging: 0.15, experimental: 0.05 } : lean?.explore === 'adventurous' ? { strong: 0.1, related: 0.2, emerging: 0.35, experimental: 0.35 } : null;
  if (!toward) return tiers;
  const out = {} as Record<Tier, number>;
  for (const t of TIERS) out[t] = ((tiers[t] || 0) + toward[t]) / 2;
  return out;
}

/* ------------------------------------------------------------- describing an algorithm */

const FACTOR_PHRASE: Record<FactorKey, string> = {
  tasteMatch: 'what sounds like what you play',
  artistAffinity: 'artists you play most',
  genreAffinity: 'genres you play most',
  collaborative: 'what similar listeners play',
  recency: 'what is new or just played',
  popularityFit: 'the popularity you usually choose',
  moodContext: 'the mood of the moment',
  discoveryBonus: 'what you have heard least',
};

/** One line on what an algorithm favours, from its two largest effective weights and its exploration. */
export function describeAlgorithm(cfg: RankConfig, mode: string): string {
  const w = effectiveWeights(cfg, mode, null);
  const top = FACTOR_KEYS.filter((k) => w[k] > 0)
    .sort((a, b) => w[b] - w[a] || FACTOR_KEYS.indexOf(a) - FACTOR_KEYS.indexOf(b))
    .slice(0, 2);
  const favours = top.length ? `Favours ${top.map((k) => FACTOR_PHRASE[k]).join(' and ')}` : 'Weighs nothing';
  const er = cfg.explorationRate;
  const explore = er >= 0.25 ? 'wide exploration' : er >= 0.12 ? 'some exploration' : er > 0 ? 'little exploration' : 'no exploration';
  return `${favours}, ${explore}`;
}

/* ------------------------------------------------------------- colours (NP-DISC-004) */

/** `#rrggbb`, lower case, or null. */
export function normalizeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

function hueOf(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The next colour for a new algorithm: the first hue of the palette no other algorithm uses, in
 * palette order. When all twelve are taken, the hue farthest (around the wheel) from the ones in use
 * — counting how many use each, so the least crowded hue wins — never a colour already on the list
 * unless every one is.
 */
export function nextColor(used: readonly (string | null | undefined)[], palette: readonly string[]): string {
  const taken = used.map(normalizeColor).filter((c): c is string => !!c);
  const pal = palette.map((c) => normalizeColor(c) ?? c.toLowerCase());
  for (const c of pal) if (!taken.includes(c)) return c;
  if (!pal.length) return '#2f61c1';
  let best = pal[0]!;
  let bestKey = -Infinity;
  for (const c of pal) {
    const uses = taken.filter((t) => t === c).length;
    const others = taken.filter((t) => t !== c).map(hueOf);
    const nearest = others.length ? Math.min(...others.map((h) => hueGap(h, hueOf(c)))) : 180;
    const key = -uses * 1000 + nearest;
    if (key > bestKey) {
      bestKey = key;
      best = c;
    }
  }
  return best;
}

/** Whether a colour is already another algorithm's. */
export function colorTaken(color: string, used: readonly (string | null | undefined)[]): boolean {
  const c = normalizeColor(color);
  return !!c && used.map(normalizeColor).includes(c);
}

/** Re-export the online Discover engine (NP-DISC-006) so it lives on window.NP_RECOMMEND. */
export { onlineQueries, rankFound, explainFound, type AskedQuery, type OnlineQueryOptions, type OnlinePick, type GatheredRow, type FoundRow } from './online.js';
/** Re-export the look-ahead ring (NP-DISC-007) so the shell can run it. */
export { planLookAhead, cachedNext, describeCache, candidatesFrom, type Candidate, type CacheEntry, type LookAheadInput, type LookAheadPlan, type PlannedFetch } from './prefetch.js';
