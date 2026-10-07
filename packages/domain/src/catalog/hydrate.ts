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
import { mergeSources, sameRecording } from './merge.js';

/** Lookups in flight at once, per page. */
export const HYDRATE_CONCURRENCY = 8;
/** The whole page's lookups, in milliseconds. */
export const HYDRATE_BUDGET_MS = 6000;
/** Rows a page fills, from the top by rank: a quota-sized slice of what is shown first. */
export const HYDRATE_MAX_ROWS = 25;

/** A platform whose cover is a video or upload thumbnail, never a store's square artwork. */
const THUMBNAIL_PLATFORMS: ReadonlySet<string> = new Set(['youtube', 'youtube-music', 'soundcloud']);

/** The facts a row can still gain from a lookup. False when there is nothing left to ask for. */
export function needsFacts(track: CatalogTrack): boolean {
  return track.bpm === null || track.isrc === null || track.explicit === null || track.artworkUrl === null || track.artists.length <= 1 || track.album === null || track.trackNumber === null || (track.releaseDate?.length ?? 0) < 10;
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
