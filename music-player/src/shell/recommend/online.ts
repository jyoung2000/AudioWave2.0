/**
 * Discover's online candidates (NP-DISC-006): the same algorithm, fed with music this device does
 * not own yet.
 *
 * Discover has always ranked the library on this device. The ranker never asked where its rows came
 * from — `rankSongs` scores any `RankSong[]` against the listener profile it derives from the play
 * log — so the only thing missing was a source of rows from elsewhere. This module is that source,
 * kept pure and separate from the surface that draws it.
 *
 * Where the rows come from. The shell's catalog search (`window.NP_FIND`, `shell/search/index.ts`)
 * answers a query with up to ten tracks from every client that can answer, in the order hub →
 * helper → this browser. With a hub or the companion's helper running, `yt-dlp` is on the other end
 * of that and the answers include YouTube and SoundCloud; with neither, the same call answers from
 * Apple Music, Deezer and MusicBrainz, and the status line says which. Nothing here knows or cares
 * which — it ranks what it is given and names the platform on the row.
 *
 * **One notion of taste.** `rank.ts` owns the algorithm: the weights, the modes, the lean, the
 * exploration and a profile built from the play log (`profile()`, rank.ts:153). Queries are derived
 * from that same profile and rows are scored by that same `rankSongs`, so "fits the current
 * algorithm" is not a claim — it is the identical function over the identical inputs. Nothing here
 * keeps a second idea of what this listener likes, because the surface would then be explaining a
 * decision the algorithm did not make.
 *
 * **The genre a query already knows.** A catalog row arrives with no genre: `NP_FIND` answers title,
 * artist, album, seconds, tempo, platform and address, and nothing else. But when the query *was* a
 * genre, the rows it returned were that genre, so the hint travels with them. That is something the
 * query carried rather than a guess, and without it `genreAffinity` could never fire for an online
 * row and every candidate would tie.
 *
 * What this deliberately does not do:
 *   - It does not fetch, play or extract audio, and it cannot make a row play instantly. A row is a
 *     candidate; the surface offers the actions the search popover already offers — fetch it into
 *     the library through the tools transport, or open it at its source. Spotify Radio and YouTube
 *     Music start a track the instant you tap it because they own the stream; this app has no
 *     permitted route to one it does not own, so a pick is fetched and then plays. Said here because
 *     the surface has to say it too, rather than implying otherwise.
 *   - It does not invent a ranking. See "one notion of taste" above.
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

/** One row as `window.NP_FIND` answers it: title, artist, album, seconds, bpm, platform, url. */
export interface FoundRow {
  t: string;
  a: string;
  al: string;
  d: number | null;
  bpm: number | null;
  p: string | null;
  u: string | null;
}

/** A search worth running, and why it was worth running. */
export interface AskedQuery {
  q: string;
  kind: 'artist' | 'genre' | 'seed';
  /** The play count behind it — what orders the queries and explains the pick. */
  weight: number;
  /** Set when this query *was* a genre, so rows it returns can be ranked with it (see the header). */
  genre: string | null;
}

export interface OnlineQueryOptions {
  /** How many artists, how many genres. Small on purpose: each one is a real search. */
  artists?: number;
  genres?: number;
  /** The seed a "radio from this" session leans on. */
  seed?: { title?: string; artist?: string } | null;
  /** A session lean's genre (NP-DISC-005) is asked for first when present. */
  leanGenre?: string | null;
}

/**
 * The searches worth running for this listener, strongest first.
 *
 * Taken from the ranker's own profile of the play log: the artists actually played and the genres
 * actually played, most-played first. There is no affinity score here to be fooled by a rejection —
 * the profile counts plays — so a dislike simply means the artist never reached the top.
 */
export function onlineQueries(
  songs: readonly RankSong[],
  plays: readonly RankPlay[],
  cfg: RankConfig,
  options: OnlineQueryOptions = {},
): AskedQuery[] {
  const p = profile(songs, plays, cfg);
  const out: AskedQuery[] = [];
  const seen = new Set<string>();

  const push = (q: string, kind: AskedQuery['kind'], weight: number): void => {
    const clean = q.trim().replace(/\s+/g, ' ').slice(0, 200);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    out.push({ q: clean, kind, weight, genre: kind === 'genre' ? clean : null });
  };

  // A lean's genre is what the person asked for in this session, so it is asked first.
  if (options.leanGenre) push(options.leanGenre, 'genre', Number.POSITIVE_INFINITY);

  const seed = options.seed;
  if (seed) {
    // The seed's own artist is the strongest statement of "more like this" there is.
    const who = seed.artist?.trim();
    if (who) push(who, 'seed', Number.POSITIVE_INFINITY);
    else if (seed.title?.trim()) push(seed.title, 'seed', Number.POSITIVE_INFINITY);
  }

  const top = (dim: Record<string, number>, n: number): Array<[string, number]> =>
    Object.entries(dim)
      .filter(([k, v]) => Boolean(k) && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  for (const [artist, n] of top(p.artistPlays, options.artists ?? 3)) push(artist, 'artist', n);
  for (const [genre, n] of top(p.genrePlays, options.genres ?? 2)) push(genre, 'genre', n);

  return out;
}

/** A found row and the query that found it, so the genre hint survives as far as the ranker. */
export interface GatheredRow {
  row: FoundRow;
  asked: AskedQuery;
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
 * lookup. `date`, `added` and `liked` are absent rather than guessed: the catalog has not told us a
 * release date, and inventing one would tilt the recency factor. Absent is the truthful value, and
 * it scores honestly as a song with no play history.
 */
export function toRankSong(gathered: GatheredRow): RankSong {
  const { row, asked } = gathered;
  const artist = (row.a ?? '').trim();
  const album = (row.al ?? '').trim();
  return {
    id: row.u ?? `found:${identityKey(row.t, artist)}`,
    title: row.t.trim().slice(0, 300),
    artist,
    ...(album ? { album } : {}),
    bpm: row.bpm && row.bpm > 0 ? row.bpm : null,
    // The query's own genre, when the query was a genre. Never inferred from a title.
    genre: asked.genre,
    date: null,
    added: null,
    liked: false,
  };
}

/** A row that survived ranking, with the platform, address and query kept for the surface. */
export interface OnlinePick {
  song: RankSong;
  /** Score, tier, explored flag and each factor's contribution — what the surface explains from. */
  row: RankResult['rows'][number];
  platform: string | null;
  url: string | null;
  asked: AskedQuery;
}

export interface RankFoundInput {
  gathered: readonly GatheredRow[];
  /** The library: the plays' own catalogue, and what this device must not be told it is missing. */
  library: readonly RankSong[];
  plays: readonly RankPlay[];
  cfg: RankConfig;
  mode: AlgoMode | string;
  lean?: RankLean | null;
  /** Row ids already chosen — queued, starred, or shown this session. */
  exclude?: readonly string[];
  /** Ids already shown, for the overexposure penalty. */
  shown?: readonly { id: string; at: number }[];
  /** Ids waiting in Up Next, which the ranker does not re-suggest. */
  queued?: readonly string[];
  limit?: number;
  seed?: number;
  now?: number;
}

/** The modes whose cuts would empty an online pool, because every row in it is unheard and unowned. */
function emptiesAnOnlinePool(cfg: RankConfig, mode: string): boolean {
  const m = cfg.modes[cfg.modes[mode] ? mode : 'for-you'];
  if (!m) return false;
  // `excludeKnownArtists` keeps only artists you have never played — the opposite of a radio built
  // from what you play. `excludeTopArtists` drops your most-played. Both are crate-digger cuts, and
  // on a pool of rows this device has never heard they would leave nothing, or the wrong thing.
  return m.excludeKnownArtists || m.excludeTopArtists;
}

/** What was actually asked and what it did, so the surface can be honest about a short list. */
export interface FoundDiagnostics {
  /** The mode actually used — not the one asked for, when its cuts made it unusable here. */
  mode: string;
  /** True when the mode was changed for the reason above, so the surface can say so. */
  modeChanged: boolean;
  /** How many rows arrived, how many were new to this device, how many the ranker scored. */
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
 * song found on both YouTube and SoundCloud is one candidate, and what the device already has is not
 * a candidate at all.
 */
export function rankFound(input: RankFoundInput): {
  result: RankResult;
  picks: OnlinePick[];
  diagnostics: FoundDiagnostics;
} {
  const mode = emptiesAnOnlinePool(input.cfg, input.mode) ? 'for-you' : input.mode;

  const owned = new Set(input.library.map((s) => identityKey(s.title, s.artist)));
  const exclude = new Set(input.exclude ?? []);

  const byId = new Map<string, GatheredRow>();
  let arrived = 0;
  for (const g of input.gathered) {
    arrived += 1;
    const row = g?.row;
    if (!row || typeof row.t !== 'string' || !row.t.trim()) continue;
    if (owned.has(identityKey(row.t, row.a ?? ''))) continue;
    const song = toRankSong(g);
    if (exclude.has(song.id)) continue;
    if (!byId.has(song.id)) byId.set(song.id, g);
  }

  const gathered = [...byId.values()];
  const songs = gathered.map(toRankSong);
  const candidateIds = new Set(songs.map((s) => s.id));
  const songsById = new Map(gathered.map((g) => [toRankSong(g).id, g]));

  // The ranker builds its profile by joining the play log to the songs it is given (`profile()`,
  // rank.ts:154: a play whose id is not among `songs` is skipped). Handed only the online rows it
  // would resolve no play to any artist, and every candidate would score zero affinity — the exact
  // opposite of "fits the algorithm". So the library is passed too, and its own ids go in
  // `exclude`, which the ranker applies *after* the profile is built (rank.ts:254 versus 271): the
  // library informs the taste and is not itself offered.
  const libraryIds = input.library.map((s) => s.id);
  const result = rankSongs({
    songs: [...input.library, ...songs],
    plays: input.plays,
    cfg: input.cfg,
    mode,
    lean: input.lean ?? null,
    exclude: [...libraryIds, ...exclude],
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.shown ? { shown: input.shown } : {}),
    ...(input.queued ? { queued: input.queued } : {}),
  });

  // Only the found rows are offered. `eligible` counts the library as well, so it is not the number
  // to report; what was actually ranked here is how many candidates survived the mode's cuts.
  const candidateRows = result.rows.filter((r) => candidateIds.has(r.song.id));
  const take = input.limit ?? candidateRows.length;
  const picks: OnlinePick[] = candidateRows.slice(0, take).flatMap((row) => {
    const g = songsById.get(row.song.id);
    if (!g) return [];
    return [{ song: row.song, row, platform: g.row.p ?? null, url: g.row.u ?? null, asked: g.asked }];
  });

  return {
    result,
    picks,
    diagnostics: {
      mode,
      modeChanged: mode !== input.mode,
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
  recency: 'newer than most of what you play',
  discoveryBonus: 'something you have heard least',
  collaborative: 'other listeners',
  popularityFit: 'how well known it is',
  moodContext: 'what you play at this hour',
};

/**
 * One line a person can read for a pick, from what the ranker actually did.
 *
 * The strongest factor in `row.parts` is the factor that put this row here, so that is what it
 * names — never a generic "because you like music", and never a claim about a signal the ranking
 * did not use. `explain()` in `lib/discover.ts` is the local counterpart, and reads in the same
 * voice.
 */
export function explainFound(pick: OnlinePick): string {
  const parts = pick.row.parts as Record<string, number>;
  let best: string | null = null;
  for (const [k, v] of Object.entries(parts)) {
    if (v > 0 && (best === null || v > parts[best]!)) best = k;
  }
  const what = best ? (FACTOR_WORDS[best] ?? null) : null;
  const why = what ? `Because of ${what}` : 'Picked from what you have been listening to';
  const where = pick.platform ? ` on ${pick.platform}` : '';
  return `${why}${where} — not on this device yet`;
}
