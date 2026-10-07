/**
 * A fetch that answers from the recorded fixtures in `tests/fixtures/catalog/` — no network.
 *
 * Fixtures were recorded by hand on 2026-10-06 from the public, keyless APIs and trimmed (fewer
 * rows, no country lists or per-user tokens, signed preview URLs cut short, a playlist creator
 * renamed). LRCLIB's shape is real but its lyrics are placeholder lines, and its `lyricsfile` field
 * is dropped: song lyrics are not ours to copy. `odesli-deprecated.json` is SongLink's real keyless
 * answer that day (401 PUBLIC_API_ACCESS_DEPRECATED); `odesli-links.json` follows SongLink's
 * documented shape, since recording one needs a key. The `ytdlp-*.json` files follow yt-dlp's flat
 * output as recorded in docker-container/tests/fixtures/media-metadata/.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CatalogFetch, CatalogResponse } from '@now-playing/domain/catalog';

export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/catalog/${name}.json`, import.meta.url)), 'utf8'));
}

export type Route = [RegExp, string | { status: number; body?: unknown; headers?: Record<string, string> } | (() => never)];

export interface FixtureFetch {
  fetch: CatalogFetch;
  calls: string[];
}

/** First matching route answers; an unmatched URL is a test bug and fails loudly. */
export function fixtureFetch(routes: Route[]): FixtureFetch {
  const calls: string[] = [];
  const fetch: CatalogFetch = async (url) => {
    calls.push(url);
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error(`No fixture for ${url}`);
    const answer = route[1];
    if (typeof answer === 'function') return answer();
    const { status, body, headers } = typeof answer === 'string' ? { status: 200, body: fixture(answer), headers: {} } : { headers: {}, ...answer };
    const response: CatalogResponse = {
      status,
      headers: { get: (name: string) => (headers as Record<string, string>)[name.toLowerCase()] ?? null },
      json: async () => body,
      // A page (an HTML body given as a string) is its own text.
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
    return response;
  };
  return { fetch, calls };
}

/** The usual routes for "daft punk get lucky" on every keyless service. */
export const STANDARD_ROUTES: Route[] = [
  [/itunes\.apple\.com\/search\?.*entity=song/, 'itunes-search-song'],
  [/itunes\.apple\.com\/search\?.*entity=musicArtist/, 'itunes-search-artist'],
  [/itunes\.apple\.com\/search\?.*entity=album/, 'itunes-search-album'],
  [/api\.deezer\.com\/search\/track/, 'deezer-search-track'],
  [/api\.deezer\.com\/search\/artist/, 'deezer-search-artist'],
  [/api\.deezer\.com\/search\/album/, 'deezer-search-album'],
  [/api\.deezer\.com\/search\/playlist/, 'deezer-search-playlist'],
  [/api\.deezer\.com\/track\/isrc:USQX91300108/, 'deezer-isrc'],
  [/api\.deezer\.com\/track\/isrc:/, 'deezer-isrc-missing'],
  [/musicbrainz\.org\/ws\/2\/recording\?query=/, 'musicbrainz-recording-search'],
  [/musicbrainz\.org\/ws\/2\/isrc\//, 'musicbrainz-isrc'],
  [/musicbrainz\.org\/ws\/2\/recording\/[0-9a-f-]+\?/, 'musicbrainz-recording'],
  [/musicbrainz\.org\/ws\/2\/release\/[0-9a-f-]+\?inc=labels/, 'musicbrainz-release-labels'],
];
