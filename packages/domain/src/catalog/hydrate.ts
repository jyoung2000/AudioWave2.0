/**
 * Every result carries its facts (UX-CAT-006): a search page's rows, an album's songs and an
 * artist's top songs are filled in after they are assembled, with a bounded, concurrent, cached
 * lookup per row.
 *
 * Where the facts come from, in order:
 *   - a Deezer source → `/track/{id}`: bpm, contributors (→ `artists`), ISRC, explicit, the full
 *     release date, the 1000 px cover, track and disc position, the album's title;
 *   - else an ISRC → `/track/isrc:{isrc}` (the same detail);
 *   - else one exact "artist title" Deezer search, taken only when it is the same recording
 *     (`sameRecording`: same names, same version, within three seconds) → `/track/{id}`;
 *   - a MusicBrainz-only row still without a cover → the Cover Art Archive's front image for the
 *     recording's first release, kept as `artworkUrl` only when the archive lists a front image.
 *
 * Nothing is downgraded: a field already known stays, only nulls are filled (an iTunes row keeps its
 * 600 px artwork; a row whose only cover is a video thumbnail takes the store's square cover, as the
 * merger does). The budget is the caller's: at most `concurrency` lookups in flight, nothing started
 * after the deadline, and a lookup that runs past it is dropped, never awaited.
 */
import type { CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { CATALOG_PAGE_MAX } from '@now-playing/contracts';
import { matchArtist, mergeSources, sameRecording } from './merge.js';

/** Lookups in flight at once, per page. */
export const HYDRATE_CONCURRENCY = 8;
/** The whole page's lookups, in milliseconds. */
export const HYDRATE_BUDGET_MS = 6000;
/** Rows a page fills, from the top by rank: a quota-sized slice of what is shown first. */
export const HYDRATE_MAX_ROWS = 25;

/**
 * Genre lookups asked of Apple per filling pass.
 *
 * Apple allows about 20 searches a minute and the catalog's own searching spends from the same
 * budget, while a page can bring `HYDRATE_MAX_ROWS` rows needing a genre. Asking for every one
 * would spend the minute on genres and leave searching itself resting, which is a worse page than
 * one with some genres still missing. Rows are filled from the top by rank, so the ones a listener
 * actually looks at are the ones that get asked.
 */
export const APPLE_GENRE_MAX_ASKS = 8;

/**
 * Rows of one page a genre pass looks at.
 *
 * A page is at most `CATALOG_PAGE_MAX` rows, and reading a genre out of what a store already said
 * costs no call, so the pass covers the whole page rather than the facts window's leading slice:
 * the rows further down are exactly the ones that were never tagged. Only `APPLE_GENRE_MAX_ASKS`
 * of them can cause a call.
 */
export const GENRE_REACH_MAX_ROWS = CATALOG_PAGE_MAX;

/**
 * Songs read from one Apple genre search.
 *
 * Apple answers a search with up to 200 rows for one call; asking for five and keeping only the one
 * that matched threw away the rest of the artist's catalog, which is exactly what the other rows of
 * the page need. Twenty-five is one call either way — the cap that matters is
 * `APPLE_GENRE_MAX_ASKS`, the number of calls — and it is what lets eight asks tag a page of forty.
 */
export const APPLE_GENRE_SEARCH_LIMIT = 25;

/** A platform whose cover is a video or upload thumbnail, never a store's square artwork. */
const THUMBNAIL_PLATFORMS: ReadonlySet<string> = new Set(['youtube', 'youtube-music', 'soundcloud']);

/** A row that could still be given a genre: none stated, and a title to look it up by. */
export function needsGenre(track: Pick<CatalogTrack, 'genre' | 'title'>): boolean {
  return track.genre === null && track.title.trim().length > 0;
}

/**
 * The order a genre pass asks about rows: a turn each platform, round and round.
 *
 * Asking from the top of the page spent every ask on the service that answered first and in bulk
 * (Deezer, which states no genre of its own), so the YouTube and SoundCloud rows further down were
 * never asked about at all — 8 % of them carried a genre. Taking a turn from each platform in
 * sequence gives every service's rows a share of the same budget, and within a platform the page's
 * own order is kept, so the rows a listener sees first are still the ones asked about first.
 */
export function fairGenreOrder<T extends { sources: readonly CatalogSource[] }>(rows: readonly T[]): number[] {
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const platform = row.sources[0]?.platform ?? '';
    const list = groups.get(platform);
    if (list) list.push(index);
    else groups.set(platform, [index]);
  });
  const lists = [...groups.values()];
  const out: number[] = [];
  for (let turn = 0; out.length < rows.length; turn += 1) {
    for (const list of lists) if (turn < list.length) out.push(list[turn]!);
  }
  return out;
}

/**
 * What a store has already said about songs, kept so the rest of a page can read it for free.
 *
 * One Apple search answers with a page of the artist's songs; the pass that asked only needed one
 * of them and the rest were dropped, so the next row of the same artist cost another call. Keeping
 * every answered song means the call budget buys matches for the whole page, and a later pass with
 * no budget left still tags what is already in hand instead of giving up.
 *
 * Only a candidate that states a genre is kept, and a row takes one only through the merger's own
 * identity test (`sameRecording`): a same-titled different recording contributes nothing, so no
 * genre is ever invented.
 */
export class GenrePool {
  /** By the same main-artist key `sameRecording` compares on, so a long page is not a full scan. */
  private readonly byArtist = new Map<string, CatalogTrack[]>();
  /** By ISRC, the one identity `sameRecording` accepts across differing artist spellings. */
  private readonly byIsrc = new Map<string, CatalogTrack>();
  private order: CatalogTrack[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly max = 2000) {}

  private static key(track: CatalogTrack): string {
    return matchArtist(track.artist);
  }

  add(candidates: readonly CatalogTrack[]): void {
    for (const candidate of candidates) {
      if (!candidate.genre || this.seen.has(candidate.id)) continue;
      this.seen.add(candidate.id);
      this.order.push(candidate);
      const key = GenrePool.key(candidate);
      const list = this.byArtist.get(key);
      if (list) list.push(candidate);
      else this.byArtist.set(key, [candidate]);
      if (candidate.isrc && !this.byIsrc.has(candidate.isrc)) this.byIsrc.set(candidate.isrc, candidate);
    }
    for (const gone of this.order.splice(0, Math.max(0, this.order.length - this.max))) {
      this.seen.delete(gone.id);
      if (gone.isrc && this.byIsrc.get(gone.isrc) === gone) this.byIsrc.delete(gone.isrc);
      const list = this.byArtist.get(GenrePool.key(gone));
      if (!list) continue;
      const at = list.indexOf(gone);
      if (at !== -1) list.splice(at, 1);
      if (!list.length) this.byArtist.delete(GenrePool.key(gone));
    }
  }

  /** The stored record of this very recording, or null. Never a near miss, never a row with a genre. */
  match(row: CatalogTrack): CatalogTrack | null {
    if (!needsGenre(row)) return null;
    const byIsrc = row.isrc ? this.byIsrc.get(row.isrc) : undefined;
    if (byIsrc && sameRecording(row, byIsrc)) return byIsrc;
    return this.byArtist.get(GenrePool.key(row))?.find((candidate) => sameRecording(row, candidate)) ?? null;
  }

  get size(): number {
    return this.order.length;
  }

  clear(): void {
    this.order = [];
    this.byArtist.clear();
    this.byIsrc.clear();
    this.seen.clear();
  }
}

/** The facts a row can still gain from a lookup. False when there is nothing left to ask for. */
export function needsFacts(track: CatalogTrack): boolean {
  return track.bpm === null || track.isrc === null || track.explicit === null || track.artworkUrl === null || track.artists.length <= 1 || track.album === null || track.trackNumber === null || (track.releaseDate?.length ?? 0) < 10 || track.genre === null || track.artistId === null;
}

/** Whether a row's cover is at best a thumbnail from an upload, so a store's cover should replace it. */
export function coverIsThumbnail(track: Pick<CatalogTrack, 'artworkUrl' | 'sources'>): boolean {
  if (!track.artworkUrl) return true;
  return track.sources.length > 0 && track.sources.every((s) => THUMBNAIL_PLATFORMS.has(s.platform));
}

/**
 * `into` with its nulls filled from `detail` (a store's full record of the same recording). Known
 * fields stay; the fuller release date wins; the credit list grows only when the detail names more
 * people than the row already does; the store's cover replaces a thumbnail, never a store's cover.
 * `matchedBy` says how the detail was tied to the row, for the source it adds.
 */
export function fillTrack(into: CatalogTrack, detail: CatalogTrack, matchedBy: CatalogSource['matchedBy']): CatalogTrack {
  const fill = <K extends keyof CatalogTrack>(key: K): CatalogTrack[K] => (into[key] ?? detail[key]) as CatalogTrack[K];
  const artists = detail.artists.length > into.artists.length ? detail.artists : into.artists;
  const sources = mergeSources(
    into.sources,
    detail.sources.map((s) => ({ ...s, matchedBy })),
  );
  return {
    ...into,
    artists,
    album: fill('album'),
    albumArtist: fill('albumArtist'),
    durationMs: fill('durationMs'),
    isrc: fill('isrc'),
    artworkUrl: coverIsThumbnail(into) && detail.artworkUrl ? detail.artworkUrl : into.artworkUrl,
    releaseDate: (into.releaseDate?.length ?? 0) >= (detail.releaseDate?.length ?? 0) ? into.releaseDate : detail.releaseDate,
    year: fill('year'),
    trackNumber: fill('trackNumber'),
    discNumber: fill('discNumber'),
    bpm: fill('bpm'),
    explicit: fill('explicit'),
    genre: fill('genre'),
    artistId: fill('artistId'),
    albumId: fill('albumId'),
    // Additive, like the credits: a word one store knows is still true when the other never
    // heard it. Deduped and capped the same way the merger caps them.
    tags: [...new Set([...into.tags, ...detail.tags])].slice(0, 30),
    label: fill('label'),
    sources,
  };
}

/** Whether a Deezer detail found by name is this row: the merger's own identity, nothing looser. */
export function isSameRecording(row: CatalogTrack, detail: CatalogTrack): boolean {
  return sameRecording(row, detail);
}

/** Whether `a` and `b` differ in any field a row shows (so a chunk carries only rows that changed). */
export function trackChanged(a: CatalogTrack, b: CatalogTrack): boolean {
  if (a === b) return false;
  for (const key of Object.keys(a) as Array<keyof CatalogTrack>) {
    const x = a[key];
    const y = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (JSON.stringify(x) !== JSON.stringify(y)) return true;
    } else if (x !== y) return true;
  }
  return false;
}

export interface PoolOptions {
  concurrency: number;
  /** An absolute time (the engine's clock); nothing starts after it. */
  deadline: number;
  now: () => number;
  signal?: AbortSignal | undefined;
}

/**
 * Runs `work` over `items`, at most `concurrency` at a time, starting nothing after the deadline.
 * Resolves when every started job has settled or the deadline has passed, whichever is first: a
 * job still running then is left to finish on its own (its answer lands in the cache for next time).
 * Returns the results of the jobs that finished in time, by item index.
 */
export async function runPool<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>, options: PoolOptions): Promise<Map<number, R>> {
  const out = new Map<number, R>();
  if (!items.length) return out;
  let next = 0;
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    const launch = (): void => {
      if (settled) return;
      while (active < options.concurrency && next < items.length && options.now() < options.deadline && !options.signal?.aborted) {
        const index = next++;
        active += 1;
        work(items[index]!, index)
          .then((result) => {
            if (!settled) out.set(index, result);
          })
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            if (active === 0 && (next >= items.length || options.now() >= options.deadline || options.signal?.aborted)) finish();
            else launch();
          });
      }
      if (active === 0) finish();
    };
    const left = options.deadline - options.now();
    timer = setTimeout(finish, Math.max(0, left));
    launch();
  });
  return out;
}
