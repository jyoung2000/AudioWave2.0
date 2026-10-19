/**
 * A fixed, captured-shape search page for measuring genre reach.
 *
 * Shaped after what a real "one artist" page looks like once the merger has ranked it (recorded
 * 2026-10-18 while chasing the 8 % figure): Deezer answers first and in bulk with no genre at all,
 * Apple's own rows carry their stated genre, and the yt-dlp rows (YouTube, then SoundCloud) land
 * last — past the 25-row fill window. Numbers here are frozen so a before/after is the same page
 * both times, never a live total that shifts between runs.
 */
import type { CatalogPlatform, CatalogTrack } from '@now-playing/contracts';

export interface PageSpec {
  platform: CatalogPlatform;
  /** Song number: the same number on two platforms is the same recording. */
  song: number;
}

/** 20 Deezer rows, 5 Apple rows, 9 YouTube rows, 6 SoundCloud rows — 40 in all. */
export const PAGE: readonly PageSpec[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ platform: 'deezer' as const, song: i + 1 })),
  ...Array.from({ length: 5 }, (_, i) => ({ platform: 'apple-music' as const, song: i + 21 })),
  ...Array.from({ length: 9 }, (_, i) => ({ platform: 'youtube' as const, song: i + 26 })),
  ...Array.from({ length: 6 }, (_, i) => ({ platform: 'soundcloud' as const, song: i + 35 })),
];

export const ARTIST = 'Night Signal';
export const songTitle = (song: number): string => `Pulse ${song}`;
export const songDuration = (song: number): number => 180_000 + song * 1000;

/** Which songs Apple's catalog carries, and the genre Apple states for each. */
export const APPLE_CATALOG: ReadonlyMap<number, string> = new Map([
  ...Array.from({ length: 20 }, (_, i) => [i + 1, 'Electronic'] as const),
  ...Array.from({ length: 7 }, (_, i) => [i + 26, 'Electronic'] as const),
  ...Array.from({ length: 4 }, (_, i) => [i + 35, 'House'] as const),
  // Apple also carries song 40, which SoundCloud already called "Bass": the stated word must win.
  [40, 'House'] as const,
]);

function row(spec: PageSpec, position: number): CatalogTrack {
  const stated = spec.platform === 'apple-music' ? 'Electronic' : spec.platform === 'soundcloud' && spec.song === 40 ? 'Bass' : null;
  // yt-dlp rows carry an uploader's title and a thumbnail-era duration a second or two off, as real
  // ones do; song 32's upload is 9 s longer than Apple's, past the matcher's three-second tolerance,
  // and song 37's SoundCloud title carries a suffix the matcher does not strip. Both must stay
  // untagged: a near miss is not a match.
  const title =
    spec.platform === 'youtube'
      ? `${ARTIST} - ${songTitle(spec.song)} (Official Video)`
      : spec.platform === 'soundcloud' && spec.song === 37
        ? `${songTitle(spec.song)} [Free Download]`
        : songTitle(spec.song);
  const duration = spec.platform === 'youtube' ? songDuration(spec.song) + (spec.song === 32 ? 9000 : 2000) : spec.platform === 'soundcloud' ? songDuration(spec.song) - 1000 : songDuration(spec.song);
  return {
    id: `${spec.platform}:${spec.song}`,
    title,
    artist: ARTIST,
    artists: [ARTIST],
    album: spec.platform === 'deezer' ? 'Signals' : null,
    albumArtist: null,
    durationMs: duration,
    isrc: null,
    artworkUrl: null,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: stated,
    artistId: null,
    albumId: null,
    tags: [],
    label: null,
    sources: [{ platform: spec.platform, id: String(spec.song), url: `https://example.test/${spec.platform}/${spec.song}`, previewUrl: null, matchedBy: 'search' }],
    rank: 100 - position,
  };
}

export function page(): CatalogTrack[] {
  return PAGE.map(row);
}

/**
 * An iTunes search answer for `term`, as Apple answers one: the song asked for when Apple carries
 * it, then more of the same artist's songs (Apple returns up to `limit` rows, not one).
 */
export function appleAnswer(term: string, limit = 5): { results: unknown[] } {
  const asked = /Pulse (\d+)/.exec(term);
  const known = [...APPLE_CATALOG.keys()];
  const first = asked && APPLE_CATALOG.has(Number(asked[1])) ? Number(asked[1]) : null;
  const order = first === null ? [] : [first, ...known.filter((s) => s !== first).sort((a, b) => Math.abs(a - first) - Math.abs(b - first) || a - b)];
  return {
    results: order.slice(0, limit).map((song) => ({
      wrapperType: 'track',
      kind: 'song',
      trackId: 900_000 + song,
      trackName: songTitle(song),
      artistName: ARTIST,
      collectionName: 'Signals',
      trackTimeMillis: songDuration(song),
      trackNumber: song,
      discNumber: 1,
      releaseDate: '2024-03-01T07:00:00Z',
      trackExplicitness: 'notExplicit',
      primaryGenreName: APPLE_CATALOG.get(song),
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg',
      trackViewUrl: `https://music.apple.com/us/album/pulse/${900_000 + song}?i=${900_000 + song}&uo=4`,
      artistId: 4242,
      collectionId: 777,
    })),
  };
}

/** Rows a measurement counts: a platform's rows that have a genre, over its rows in all. */
export function reach(rows: readonly CatalogTrack[]): Record<string, { withGenre: number; rows: number }> {
  const out: Record<string, { withGenre: number; rows: number }> = {};
  for (const r of rows) {
    const p = r.sources[0]?.platform ?? 'none';
    const cell = (out[p] ??= { withGenre: 0, rows: 0 });
    cell.rows += 1;
    if (r.genre) cell.withGenre += 1;
  }
  return out;
}

/** The page with `filled` (the rows hydrate changed) applied by id, order untouched. */
export function applyFilled(original: readonly CatalogTrack[], filled: readonly CatalogTrack[]): CatalogTrack[] {
  const by = new Map(filled.map((t) => [t.id, t]));
  return original.map((t) => by.get(t.id) ?? t);
}
