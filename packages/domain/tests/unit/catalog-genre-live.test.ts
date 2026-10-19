/**
 * One live, opt-in measurement of genre reach against the real keyless Apple API.
 *
 * Skipped unless AIRWAVE_LIVE_CATALOG=1. It makes at most APPLE_GENRE_MAX_ASKS (8) iTunes Search
 * calls for a single page — inside Apple's published ~20/minute — and no other provider is touched
 * (Deezer is switched off, no yt-dlp). It asserts only what cannot drift: the call ceiling, that no
 * stated genre is overwritten, and that reach is at least as good as the frozen-fixture figure. The
 * exact per-row genres are Apple's to change, so they are printed, not asserted.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogPlatform, CatalogTrack } from '@now-playing/contracts';
import { APPLE_GENRE_MAX_ASKS, CatalogEngine, type CatalogFetch } from '@now-playing/domain/catalog';

const LIVE = process.env['AIRWAVE_LIVE_CATALOG'] === '1';

/** Real songs, as a yt-dlp row would carry them: an uploader's title, a rough duration, no genre. */
const ROWS: Array<{ platform: CatalogPlatform; artist: string; title: string; durationMs: number }> = [
  { platform: 'youtube', artist: 'Daft Punk', title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', durationMs: 369_000 },
  { platform: 'youtube', artist: 'Daft Punk', title: 'Daft Punk - Instant Crush (Official Audio) ft. Julian Casablancas', durationMs: 337_000 },
  { platform: 'youtube', artist: 'Daft Punk', title: 'Daft Punk - Lose Yourself to Dance (Official Audio)', durationMs: 353_000 },
  { platform: 'soundcloud', artist: 'Daft Punk', title: 'Giorgio by Moroder', durationMs: 544_000 },
  { platform: 'soundcloud', artist: 'Daft Punk', title: 'Doin’ it Right', durationMs: 251_000 },
  { platform: 'youtube', artist: 'Fleetwood Mac', title: 'Fleetwood Mac - Dreams (Official Music Video)', durationMs: 257_000 },
  { platform: 'youtube', artist: 'Fleetwood Mac', title: 'Fleetwood Mac - The Chain (Official Audio)', durationMs: 269_000 },
  { platform: 'soundcloud', artist: 'Fleetwood Mac', title: 'Go Your Own Way', durationMs: 223_000 },
  // A genre a platform stated itself: it must survive untouched, whatever Apple says.
  { platform: 'soundcloud', artist: 'Daft Punk', title: 'Within', durationMs: 228_000 },
];

function row(spec: (typeof ROWS)[number], i: number, genre: string | null = null): CatalogTrack {
  return {
    id: `${spec.platform}:live-${i}`,
    title: spec.title,
    artist: spec.artist,
    artists: [spec.artist],
    album: null,
    albumArtist: null,
    durationMs: spec.durationMs,
    isrc: null,
    artworkUrl: null,
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre,
    artistId: null,
    albumId: null,
    tags: [],
    label: null,
    sources: [{ platform: spec.platform, id: `live-${i}`, url: `https://example.test/${spec.platform}/${i}`, previewUrl: null, matchedBy: 'search' }],
    rank: 100 - i,
  };
}

describe.skipIf(!LIVE)('genre reach, live against Apple (AIRWAVE_LIVE_CATALOG=1)', () => {
  it('tags most of a page of yt-dlp rows within the call cap, keeping stated genres', async () => {
    const calls: string[] = [];
    const fetch: CatalogFetch = async (url, init) => {
      calls.push(url);
      const response = await globalThis.fetch(url, init as RequestInit);
      return { status: response.status, headers: { get: (name) => response.headers.get(name) }, json: () => response.json(), text: () => response.text() };
    };
    const engine = new CatalogEngine({ fetch, userAgent: 'AirwaveTest/1.0 (live reach check)', crossLinkTop: 0, timeouts: { itunes: 15_000 } });
    const page = ROWS.map((spec, i) => row(spec, i, i === ROWS.length - 1 ? 'Electronica' : null));
    const filled = await engine.hydrateTracks(page, { askDeezer: false });

    const byId = new Map(filled.map((t) => [t.id, t]));
    const after = page.map((t) => byId.get(t.id) ?? t);
    const appleCalls = calls.filter((c) => c.includes('itunes.apple.com'));
    const tagged = after.filter((t) => t.genre).length;
    // Printed, not asserted: Apple's own words, which are Apple's to change.
    console.log(`live: ${appleCalls.length} Apple calls, ${tagged}/${after.length} rows tagged —`, after.map((t) => `${t.title.slice(0, 28)}=${t.genre ?? '—'}`).join(', '));

    expect(appleCalls.length).toBeLessThanOrEqual(APPLE_GENRE_MAX_ASKS);
    expect(calls.filter((c) => !c.includes('itunes.apple.com'))).toEqual([]);
    // The stated genre is still the platform's own word.
    expect(after.at(-1)!.genre).toBe('Electronica');
    // At least as far as the frozen page reached for its yt-dlp rows (10 of 15 there).
    expect(tagged).toBeGreaterThanOrEqual(6);
  }, 90_000);
});
