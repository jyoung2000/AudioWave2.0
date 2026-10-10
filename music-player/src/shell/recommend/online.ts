/**
 * Discover's online candidates (NP-DISC-006): the same algorithm, fed with music this device does
 * not own yet.
 *
 * Discover has always ranked the library on this device. The ranker never asked where its rows came
 * from — `rankSongs` scores any `RankSong[]` against the listener profile it derives from the play
 * log — so the only thing missing was a source of rows from elsewhere. This module is that source,
 * kept pure and separate from the surface that draws it (`shell/search/discover.ts` asks the
 * catalog; make-shell.py draws the rows).
 *
 * Where the rows come from. The catalog search answers a query from whichever client can answer, in
 * the order hub → companion helper → this browser. With a hub or the helper, yt-dlp is on the other
 * end and the answers include YouTube and SoundCloud; with neither, the same call answers from Apple
 * Music, Deezer and MusicBrainz in this page, keylessly. Nothing here knows or cares which — it ranks
 * what it is given and keeps the platform on the row.
 *
 * **One notion of taste.** `rank.ts` owns the algorithm: the weights, the modes, the lean, the
 * exploration and a profile built from the play log (`profile()`). Queries are derived from that same
 * profile and rows are scored by that same `rankSongs`, under the mode the person chose, so "ranked
 * by the current algorithm" is not a claim — it is the identical function over the identical inputs.
 * A mode that cuts the artists you play (Deep cuts) is not swapped for another: the queries follow
 * it instead, asking for genres rather than artists, so its cuts leave something to rank.
 *
 * **The genre a row carries.** A catalog song often arrives with a genre of its own (the engine's
 * enrichment); when it does not and the query *was* a genre, the rows it returned were that genre, so
 * the hint travels with them. That is something the query carried rather than a guess, and without it
 * `genreAffinity` could rarely fire for an online row.
 *
 * What this deliberately does not do: fetch, play or extract audio. A pick is a candidate; the
 * surface offers what it offers any song from the catalog — its 30-second preview, labelled as one,
 * and a fetch through the hub or the companion once the person says why they may have the file.
 */
import { normalizeArtist, normalizeText } from '@now-playing/domain';
import {
  profile,
  rankSongs,
  type AlgoMode,
  type RankConfig,
  type RankLean,
  type RankPlay,
  type RankResult,
  type RankSong,
} from './rank.js';

/**
 * One found song, as the ranker needs it: title, artist, album, seconds, bpm, platform (as named to a
 * person), address, and — when the catalog gave them — its genre and its 30-second clip.
 */
export interface FoundRow {
  t: string;
  a: string;
  al: string;
  d: number | null;
  bpm: number | null;
  p: string | null;
  u: string | null;
  /** The catalog's own genre for the song, when it had one. */
  g?: string | null;
  /** Its 30-second preview, when a platform offers one (http(s) only, checked by the caller). */
  c?: string | null;
}

/** A search worth running, and why it was worth running. */
export interface AskedQuery {
  q: string;
  kind: 'artist' | 'genre';
  /** The play count behind it — what orders the queries and explains the pick. */
  weight: number;
  /** Set when this query *was* a genre, so rows it returns can be ranked with it (see the header). */
  genre: string | null;
}

export interface OnlineQueryOptions {
  /** How many artists, how many genres. Small on purpose: each one is a real search. */
  artists?: number;
  genres?: number;
  /** A session lean's genre (NP-DISC-005) is asked for first when present. */
  leanGenre?: string | null;
  /** The mode Discover ranks under: its cuts decide which queries can feed it (see the header). */
  mode?: AlgoMode | string;
}

/**
 * The searches worth running for this listener, strongest first.
 *
 * Taken from the ranker's own profile of the play log: the artists actually played and the genres
 * actually played, most-played first. A mode that leaves out every artist you know asks for genres
 * instead (as many as it would have asked in all); a mode that leaves out your top artist does not
 * ask for that artist.
 */
export function onlineQueries(
  songs: readonly RankSong[],
  plays: readonly RankPlay[],
  cfg: RankConfig,
  options: OnlineQueryOptions = {},
): AskedQuery[] {
  const p = profile(songs, plays, cfg);
  const m = cfg.modes[options.mode && cfg.modes[options.mode] ? options.mode : 'for-you'];
  const out: AskedQuery[] = [];
  const seen = new Set<string>();

  const push = (q: string, kind: AskedQuery['kind'], weight: number): void => {
    const clean = q.trim().replace(/\s+/g, ' ').slice(0, 200);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    out.push({ q: clean, kind, weight, genre: kind === 'genre' ? key : null });
  };

  // A lean's genre is what the person asked for in this session, so it is asked first.
  if (options.leanGenre) push(options.leanGenre, 'genre', Number.POSITIVE_INFINITY);

  const top = (dim: Record<string, number>, n: number, skip: string | null = null): Array<[string, number]> =>
    Object.entries(dim)
      .filter(([k, v]) => Boolean(k) && v > 0 && k !== skip)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, n));

  const artists = options.artists ?? 3;
  const genres = options.genres ?? 2;
  if (m?.excludeKnownArtists) {
    // Every artist you play would be cut: genres are the only queries that can feed this mode.
    for (const [genre, n] of top(p.genrePlays, artists + genres)) push(genre, 'genre', n);
    return out;
  }
  const skip = m?.excludeTopArtists ? p.topArtist : null;
  for (const [artist, n] of top(p.artistPlays, artists, skip)) push(artist, 'artist', n);
  for (const [genre, n] of top(p.genrePlays, genres)) push(genre, 'genre', n);
  return out;
}

/** A found row and the query that found it, so the genre hint survives as far as the ranker. */
export interface GatheredRow<X = unknown> {
  row: FoundRow;
  asked: AskedQuery;
  /** Whatever the caller wants back on the pick (the catalog's own song); the ranker never reads it. */
  extra?: X;
}

/** What makes two rows the same recording, for keeping a candidate that is not already owned. */
export function identityKey(title: string, artist: string): string {
  // The same normalisers `catalogueFromLibrary` uses, so "the same recording" means one thing in
  // this app: a trailing "!" or a different case must not make an owned song look like a candidate.
  return `${normalizeArtist(artist)}\u0000${normalizeText(title)}`;
}

/**
 * A found row as the ranker wants it.
 *
 * The id is the row's own address, so a pick maps back to the platform it came from with no second
 * lookup. `date`, `added` and `liked` are absent rather than guessed: the catalog search has not told
 * us when it reached anyone's library, and inventing a date would tilt the recency factor. Absent is
 * the truthful value, and it scores honestly as a song with no play history.
 */
export function toRankSong(gathered: GatheredRow): RankSong {
  const { row, asked } = gathered;
  const artist = (row.a ?? '').trim();
  const album = (row.al ?? '').trim();
  const genre = (row.g ?? '').trim();
  return {
    id: row.u ?? `found:${identityKey(row.t, artist)}`,
    title: row.t.trim().slice(0, 300),
    artist,
    ...(album ? { album } : {}),
    bpm: row.bpm && row.bpm > 0 ? row.bpm : null,
    // The catalog's genre when it gave one, else the query's own genre when the query was one.
    genre: genre || asked.genre,
    date: null,
    added: null,
    liked: false,
  };
}

/** A row that survived ranking, with the platform, address, clip and query kept for the surface. */
export interface OnlinePick<X = unknown> {
  song: RankSong;
  /** Score, tier, explored flag and each factor's contribution — what the surface explains from. */
  row: RankResult['rows'][number];
  platform: string | null;
  url: string | null;
  preview: string | null;
  asked: AskedQuery;
  extra?: X;
}

export interface RankFoundInput<X = unknown> {
  gathered: readonly GatheredRow<X>[];
  /** The library: the plays' own catalogue, and what this device must not be told it is missing. */
  library: readonly RankSong[];
  plays: readonly RankPlay[];
  cfg: RankConfig;
  mode: AlgoMode | string;
  lean?: RankLean | null;
  /** Row ids to leave out — what this Discover session already showed from the catalog. */
  exclude?: readonly string[];
  /** Ids already shown, for the overexposure penalty. */
  shown?: readonly { id: string; at: number }[];
  /** Ids waiting in Up Next, which the ranker does not re-suggest. */
  queued?: readonly string[];
  limit?: number;
  seed?: number;
  now?: number;
}

/** What was actually asked and what it did, so the surface can be honest about a short list. */
export interface FoundDiagnostics {
  /** The mode the rows were ranked under (the chosen one; an unknown name ranks as For you). */
  mode: string;
  /** How many rows arrived, how many were new to this device, how many survived the mode's cuts. */
  arrived: number;
  fresh: number;
  ranked: number;
  /** The queries asked, in order, once each. */
  queries: string[];
}

/**
 * Rank found rows with the listener's own algorithm.
 *
 * Deduplication happens before ranking, not after, so a duplicate does not consume a slot: the same
 * song found twice is one candidate (the first copy, which the catalog had already merged across its
 * platforms), and what the device already has is not a candidate at all.
 */
export function rankFound<X = unknown>(
  input: RankFoundInput<X>,
): {
  result: RankResult;
  picks: OnlinePick<X>[];
  diagnostics: FoundDiagnostics;
} {
  const mode = input.cfg.modes[input.mode] ? String(input.mode) : 'for-you';
  const owned = new Set(input.library.map((s) => identityKey(s.title, s.artist)));
  const exclude = new Set(input.exclude ?? []);

  const byId = new Map<string, GatheredRow<X>>();
  const byRecording = new Set<string>();
  let arrived = 0;
  for (const g of input.gathered) {
    arrived += 1;
    const row = g?.row;
    if (!row || typeof row.t !== 'string' || !row.t.trim()) continue;
    const key = identityKey(row.t, row.a ?? '');
    if (owned.has(key) || byRecording.has(key)) continue;
    const song = toRankSong(g);
    if (exclude.has(song.id) || byId.has(song.id)) continue;
    byId.set(song.id, g);
    byRecording.add(key);
  }

  const gathered = [...byId.values()];
  const songs = gathered.map(toRankSong);
  const candidateIds = new Set(songs.map((s) => s.id));

  // The ranker builds its profile by joining the play log to the songs it is given (`profile()`: a
  // play whose id is not among `songs` is skipped). Handed only the online rows it would resolve no
  // play to any artist, and every candidate would score zero affinity — the exact opposite of "fits
  // the algorithm". So the library is passed too, and its own ids go in `exclude`, which the ranker
  // applies after the profile is built: the library informs the taste and is not itself offered.
  const result = rankSongs({
    songs: [...input.library, ...songs],
    plays: input.plays,
    cfg: input.cfg,
    mode,
    lean: input.lean ?? null,
    exclude: input.library.map((s) => s.id),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.shown ? { shown: input.shown } : {}),
    ...(input.queued ? { queued: input.queued } : {}),
  });

  // Only the found rows are offered; what was ranked is how many candidates survived the mode's cuts.
  const candidateRows = result.rows.filter((r) => candidateIds.has(r.song.id));
  const take = input.limit ?? candidateRows.length;
  const picks: OnlinePick<X>[] = candidateRows.slice(0, take).flatMap((row) => {
    const g = byId.get(row.song.id);
    if (!g) return [];
    const pick: OnlinePick<X> = {
      song: row.song,
      row,
      platform: g.row.p ?? null,
      url: g.row.u ?? null,
      preview: g.row.c ?? null,
      asked: g.asked,
    };
    if (g.extra !== undefined) pick.extra = g.extra;
    return [pick];
  });

  return {
    result,
    picks,
    diagnostics: {
      mode,
      arrived,
      fresh: gathered.length,
      ranked: candidateRows.length,
      queries: [...new Set(input.gathered.map((g) => g.asked.q))],
    },
  };
}

const FACTOR_WORDS: Record<string, string> = {
  artistAffinity: 'an artist you play',
  genreAffinity: 'a genre you play',
  tasteMatch: 'the tempo and genre you play',
  recency: 'how recent it is',
  discoveryBonus: 'something you have not heard',
  collaborative: 'other listeners',
  popularityFit: 'how well known it is',
  moodContext: 'what you play at this hour',
};

/**
 * One line a person can read for a pick, from what the ranker actually did.
 *
 * The strongest factor in `row.parts` is the factor that put this row here, so that is what it
 * names — never a generic "because you like music", and never a claim about a signal the ranking did
 * not use. A row exploration placed says so, because then its score did not.
 */
export function explainFound(pick: OnlinePick): string {
  const parts = pick.row.parts as Record<string, number>;
  let best: string | null = null;
  for (const [k, v] of Object.entries(parts)) {
    if (v > 0 && (best === null || v > parts[best]!)) best = k;
  }
  const what = best ? (FACTOR_WORDS[best] ?? null) : null;
  const why = pick.row.explored
    ? 'Picked to explore'
    : what
      ? `Because of ${what}`
      : 'Picked from what you have been listening to';
  const where = pick.platform ? ` · found on ${pick.platform}` : '';
  return `${why}${where} — not on this device yet`;
}
