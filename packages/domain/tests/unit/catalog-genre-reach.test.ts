/**
 * How far a page's genres actually reach (UX-CAT-006), measured on one frozen page.
 *
 * `catalog-genre-page.ts` is the page: Deezer first and in bulk with no genre of its own, Apple's
 * own rows carrying theirs, the yt-dlp rows last and past the fill window. The same page is used
 * for every run here, so a before/after is a comparison and not two different live searches.
 *
 * Measured on this page (`pnpm vitest run --project unit packages/domain/tests/unit/catalog-genre-reach.test.ts`),
 * with the same 8 Apple calls and no Deezer calls both times:
 *   before — deezer 8/20, apple 5/5, youtube 0/9, soundcloud 1/6: 14 of 40 rows (35 %), and every
 *            one of the 8 asks went to a leading Deezer row;
 *   after  — deezer 20/20, apple 5/5, youtube 6/9, soundcloud 4/6: 35 of 40 rows (88 %).
 * The 5 rows still blank are the honest ones: 3 songs Apple does not carry, one upload 9 s off the
 * store's length, and one title the matcher cannot strip. Apple's per-pass cap and its shared
 * per-minute budget are unchanged: what changed is which rows the asks are spent on, and that one
 * answer's other songs are kept instead of thrown away.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogTrack } from '@now-playing/contracts';
import { APPLE_GENRE_MAX_ASKS, CatalogEngine, type CatalogFetch, type CatalogResponse } from '@now-playing/domain/catalog';
import { APPLE_CATALOG, applyFilled, appleAnswer, page, reach } from './catalog-genre-page.js';

const NOW = 1_700_000_000_000;

interface Harness {
  engine: CatalogEngine;
  calls: string[];
  appleCalls: () => string[];
  deezerCalls: () => string[];
}

function harness(): Harness {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    const answer = (body: unknown): CatalogResponse => ({
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (url.includes('itunes.apple.com/search')) {
      const term = new URL(url).searchParams.get('term') ?? '';
      const limit = Number(new URL(url).searchParams.get('limit') ?? 5);
      return answer(appleAnswer(term, limit));
    }
    // Deezer answers nothing for these songs: this page's genres can only come from Apple.
    if (url.includes('api.deezer.com')) return answer({ data: [], total: 0 });
    throw new Error(`unexpected call ${url}`);
  };
  const engine = new CatalogEngine({ fetch, userAgent: 'AirwaveTest/1.0 (test)', now: () => NOW, crossLinkTop: 0 });
  return {
    engine,
    calls,
    appleCalls: () => calls.filter((c) => c.includes('itunes.apple.com')),
    deezerCalls: () => calls.filter((c) => c.includes('api.deezer.com')),
  };
}

const genreOf = (rows: readonly CatalogTrack[], id: string): string | null => rows.find((r) => r.id === id)?.genre ?? null;

describe('genre reach over one frozen page', () => {
  it('spends the same Apple asks across every platform missing a genre, and keeps each answer’s other songs', async () => {
    const { engine, appleCalls, deezerCalls } = harness();
    const original = page();
    const filled = await engine.hydrateTracks(original, { askDeezer: false });
    const after = applyFilled(original, filled);

    expect(appleCalls()).toHaveLength(APPLE_GENRE_MAX_ASKS);
    expect(deezerCalls()).toHaveLength(0);
    expect(reach(after)).toEqual({
      deezer: { rows: 20, withGenre: 20 },
      'apple-music': { rows: 5, withGenre: 5 },
      youtube: { rows: 9, withGenre: 6 },
      soundcloud: { rows: 6, withGenre: 4 },
    });
    // The rows a listener never saw tagged before: the yt-dlp half of the page.
    expect(genreOf(after, 'youtube:26')).toBe('Electronic');
    expect(genreOf(after, 'soundcloud:35')).toBe('House');
  });

  it('never invents a genre and never overwrites one a platform stated', async () => {
    const { engine } = harness();
    const original = page();
    const after = applyFilled(original, await engine.hydrateTracks(original, { askDeezer: false }));

    // Apple does not carry songs 33, 34 or 39: they stay untagged rather than borrowing a neighbour's.
    for (const id of ['youtube:33', 'youtube:34', 'soundcloud:39']) {
      expect(APPLE_CATALOG.has(Number(id.split(':')[1]))).toBe(false);
      expect(genreOf(after, id)).toBeNull();
    }
    // SoundCloud stated "Bass" for song 40 and Apple calls it "House": the platform's own word stays.
    expect(APPLE_CATALOG.get(40)).toBe('House');
    expect(genreOf(after, 'soundcloud:40')).toBe('Bass');
    // Every genre present is one some platform actually stated for that very song.
    for (const row of after) {
      if (!row.genre) continue;
      const song = Number(row.id.split(':')[1]);
      const stated = row.sources[0]!.platform === 'apple-music' ? 'Electronic' : song === 40 ? 'Bass' : APPLE_CATALOG.get(song);
      expect(row.genre).toBe(stated);
    }
  });

  it('leaves the rows it was given untouched and in order', async () => {
    const { engine } = harness();
    const original = page();
    const before = structuredClone(original);
    const filled = await engine.hydrateTracks(original, { askDeezer: false });
    expect(original).toEqual(before);
    // Only changed rows come back, and they come back in the order they sit on the page.
    const positions = filled.map((row) => original.findIndex((o) => o.id === row.id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(applyFilled(original, filled).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });

  it('fills from what Apple already said when the call budget is gone, spending nothing', async () => {
    const { engine, appleCalls } = harness();
    const first = page();
    await engine.hydrateTracks(first, { askDeezer: false });
    const spent = appleCalls().length;
    expect(spent).toBe(APPLE_GENRE_MAX_ASKS);

    // A second pass with no asks left at all: the page still gains every genre Apple named, free.
    const second = page();
    const after = applyFilled(second, await engine.hydrateTracks(second, { askDeezer: false, askApple: false }));
    expect(appleCalls()).toHaveLength(spent);
    expect(genreOf(after, 'youtube:26')).toBe('Electronic');
    expect(genreOf(after, 'soundcloud:35')).toBe('House');
    expect(reach(after)['youtube']!.withGenre).toBeGreaterThanOrEqual(6);
  });

  it('asks Apple no more than the cap however many rows are missing a genre', async () => {
    const { engine, appleCalls } = harness();
    const many = [...page(), ...page().map((row) => ({ ...row, id: `x-${row.id}`, title: `${row.title} II` }))];
    await engine.hydrateTracks(many, { askDeezer: false, max: many.length });
    expect(appleCalls().length).toBeLessThanOrEqual(APPLE_GENRE_MAX_ASKS);
  });

  it('reaches past the facts window on a long page, still within the cap', async () => {
    const { engine, appleCalls } = harness();
    // 100 rows: the first 60 untagged Deezer rows, then the yt-dlp rows the old window never saw.
    const long = [...Array.from({ length: 60 }, (_, i) => ({ ...page()[0]!, id: `deezer:f${i}`, title: `Filler ${i}`, sources: [{ ...page()[0]!.sources[0]!, id: `f${i}` }] })), ...page()];
    const filled = await engine.hydrateTracks(long, { askDeezer: false });
    const after = applyFilled(long, filled);
    expect(appleCalls().length).toBeLessThanOrEqual(APPLE_GENRE_MAX_ASKS);
    // Row 86 of the page by position, and tagged: this is the reach the old pass did not have.
    expect(genreOf(after, 'youtube:26')).toBe('Electronic');
    expect(reach(after)['youtube']!.withGenre).toBeGreaterThanOrEqual(6);
    // The filler rows Apple does not carry stay blank: reach is not invention.
    expect(after.filter((r) => r.id.startsWith('deezer:f')).every((r) => r.genre === null)).toBe(true);
  });

  it('stops asking while Apple is resting, and still fills from what is in hand', async () => {
    const { engine, appleCalls } = harness();
    await engine.hydrateTracks(page(), { askDeezer: false });
    const spent = appleCalls().length;
    engine.health.restUntil('itunes', NOW + 60_000, 'resting for the test');

    const second = page();
    const after = applyFilled(second, await engine.hydrateTracks(second, { askDeezer: false }));
    expect(appleCalls()).toHaveLength(spent);
    expect(genreOf(after, 'youtube:26')).toBe('Electronic');
  });
});
