/**
 * The two pure pieces the genre pass is built from: who gets asked in what order
 * (`fairGenreOrder`), and what a store's answer leaves behind for the rest of a page (`GenrePool`).
 */
import { describe, expect, it } from 'vitest';
import type { CatalogPlatform, CatalogTrack } from '@now-playing/contracts';
import { GenrePool, fairGenreOrder, needsGenre } from '@now-playing/domain/catalog';

function row(platform: CatalogPlatform, title: string, options: { genre?: string | null; durationMs?: number | null; artist?: string } = {}): CatalogTrack {
  const artist = options.artist ?? 'Night Signal';
  return {
    id: `${platform}:${title}`,
    title,
    artist,
    artists: [artist],
    album: null,
    albumArtist: null,
    durationMs: options.durationMs === undefined ? 200_000 : options.durationMs,
    isrc: null,
    artworkUrl: null,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: options.genre ?? null,
    artistId: null,
    albumId: null,
    tags: [],
    label: null,
    sources: [{ platform, id: title, url: `https://example.test/${platform}/${encodeURIComponent(title)}`, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
  };
}

describe('needsGenre', () => {
  it('is true only for a row with no genre and a title to look one up by', () => {
    expect(needsGenre(row('youtube', 'Pulse'))).toBe(true);
    expect(needsGenre(row('youtube', 'Pulse', { genre: 'House' }))).toBe(false);
    expect(needsGenre(row('youtube', '   '))).toBe(false);
  });
});

describe('fairGenreOrder', () => {
  it('takes a turn from each platform in sequence, keeping each platform’s own order', () => {
    const rows = [row('deezer', 'a'), row('deezer', 'b'), row('deezer', 'c'), row('youtube', 'x'), row('youtube', 'y'), row('soundcloud', 'z')];
    expect(fairGenreOrder(rows)).toEqual([0, 3, 5, 1, 4, 2]);
  });

  it('is a permutation of every row, however lopsided the page', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => row('deezer', `d${i}`)), row('youtube', 'one')];
    const order = fairGenreOrder(rows);
    expect(order).toHaveLength(rows.length);
    expect([...order].sort((a, b) => a - b)).toEqual(rows.map((_, i) => i));
    // The lone YouTube row is second, not last: one service's bulk cannot crowd the page out.
    expect(order[1]).toBe(30);
  });

  it('is the page’s own order when every row is on one platform', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row('deezer', `d${i}`));
    expect(fairGenreOrder(rows)).toEqual([0, 1, 2, 3, 4]);
  });

  it('is empty for no rows', () => {
    expect(fairGenreOrder([])).toEqual([]);
  });
});

describe('GenrePool', () => {
  it('matches another platform’s copy of the same recording, within the matcher’s tolerance', () => {
    const pool = new GenrePool();
    pool.add([row('apple-music', 'Pulse 1', { genre: 'Electronic' })]);
    const match = pool.match(row('youtube', 'Night Signal - Pulse 1 (Official Video)', { durationMs: 202_000 }));
    expect(match?.genre).toBe('Electronic');
  });

  it('keeps nothing without a genre, and answers nothing for a row that already has one', () => {
    const pool = new GenrePool();
    pool.add([row('apple-music', 'Pulse 1', { genre: null })]);
    expect(pool.size).toBe(0);
    pool.add([row('apple-music', 'Pulse 1', { genre: 'Electronic' })]);
    expect(pool.match(row('soundcloud', 'Pulse 1', { genre: 'Bass' }))).toBeNull();
  });

  it('answers nothing for a different recording, however alike the names', () => {
    const pool = new GenrePool();
    pool.add([row('apple-music', 'Pulse 1', { genre: 'Electronic' })]);
    // Same title, nine seconds longer: past the three-second tolerance, so not the same recording.
    expect(pool.match(row('youtube', 'Pulse 1', { durationMs: 209_000 }))).toBeNull();
    // Same title, another artist.
    expect(pool.match(row('youtube', 'Pulse 1', { artist: 'Other Band' }))).toBeNull();
    // A version of its own stays its own row.
    expect(pool.match(row('youtube', 'Pulse 1 (Live)'))).toBeNull();
  });

  it('matches on an ISRC even when the two credits are written differently', () => {
    const pool = new GenrePool();
    const apple = { ...row('apple-music', 'Pulse 1', { genre: 'Electronic', artist: 'Night Signal & Friends' }), isrc: 'USQX91300108' };
    pool.add([apple]);
    const mine = { ...row('deezer', 'Quite Another Name', { artist: 'Night Signal' }), isrc: 'USQX91300108' };
    expect(pool.match(mine)?.genre).toBe('Electronic');
  });

  it('drops its oldest rows past its bound and forgets them', () => {
    const pool = new GenrePool(3);
    pool.add(Array.from({ length: 5 }, (_, i) => row('apple-music', `Pulse ${i}`, { genre: 'Electronic' })));
    expect(pool.size).toBe(3);
    expect(pool.match(row('youtube', 'Pulse 0'))).toBeNull();
    expect(pool.match(row('youtube', 'Pulse 4'))?.genre).toBe('Electronic');
    // A dropped row can be stored again: the bound must not leave a permanent hole.
    pool.add([row('apple-music', 'Pulse 0', { genre: 'House' })]);
    expect(pool.match(row('youtube', 'Pulse 0'))?.genre).toBe('House');
  });

  it('stores each song once however often it is answered', () => {
    const pool = new GenrePool();
    const answer = [row('apple-music', 'Pulse 1', { genre: 'Electronic' }), row('apple-music', 'Pulse 2', { genre: 'House' })];
    pool.add(answer);
    pool.add(answer);
    expect(pool.size).toBe(2);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});
