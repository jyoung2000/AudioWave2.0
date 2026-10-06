/**
 * The music catalog's answers (DEC-039), as the hub (`/api/v1/catalog/*`) and the companion's helper
 * (`/helper/v1/catalog/*`) send them, built from invented songs for the search suites. Nothing here
 * reaches the network: the suites answer every route with `page.route`, and stub the services the
 * browser engine would otherwise ask (iTunes, Deezer, MusicBrainz, LRCLIB).
 */
import type { Page, Route } from '@playwright/test';
import { CORS, HUB } from './_shell';

export const COMPANION = 'http://127.0.0.1:17999';
export const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['search:use'], hubName: 'TOWER', deviceId: 'd1' };
const AT = '2026-10-06T12:00:00.000Z';

type Platform = 'apple-music' | 'deezer' | 'musicbrainz' | 'youtube' | 'youtube-music' | 'soundcloud' | 'spotify' | 'bandcamp';
interface Source {
  platform: Platform;
  id: string | null;
  url: string;
  previewUrl: string | null;
  matchedBy: 'search' | 'isrc' | 'metadata' | 'musicbrainz' | 'spotdl' | 'odesli' | 'link';
}

export const src = (platform: Platform, id: string, over: Partial<Source> = {}): Source => ({ platform, id, url: `https://${platform}.example/${id}`, previewUrl: null, matchedBy: 'search', ...over });

/** A cover: an inline SVG, so nothing is fetched. */
export const cover = (hue: number): string =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="hsl(${hue},60%,50%)"/></svg>`).toString('base64')}`;

export function track(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title,
    artist: 'Lantern Choir',
    artists: ['Lantern Choir'],
    album: 'Night Ferries',
    albumArtist: 'Lantern Choir',
    durationMs: 214_000,
    isrc: null,
    artworkUrl: null,
    releaseDate: '2019-05-03',
    year: 2019,
    trackNumber: 1,
    discNumber: 1,
    bpm: 112,
    explicit: false,
    genre: null,
    label: null,
    sources: [src('deezer', id.split(':')[1] ?? id)],
    rank: 100,
    ...over,
  };
}

export function artist(id: string, name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name, pictureUrl: null, albumCount: 4, fans: 1200, genre: 'Folk', sources: [src('deezer', id.split(':')[1] ?? id)], rank: 50, ...over };
}

export function album(id: string, title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title, artist: 'Lantern Choir', artworkUrl: null, releaseDate: '2019-05-03', year: 2019, trackCount: 11, label: 'Quay Records', genre: 'Folk', explicit: null, upc: null, sources: [src('deezer', id.split(':')[1] ?? id)], rank: 40, ...over };
}

export type Status = { provider: 'itunes' | 'deezer' | 'musicbrainz' | 'youtube' | 'soundcloud'; state: string; count?: number; error?: string | null; retryAt?: string | null };
export const status = (list: Status[]): Array<Record<string, unknown>> => list.map((s) => ({ count: 0, latencyMs: null, error: null, retryAt: null, ...s }));

const query = (text: string) => ({ kind: 'text', text, track: null, artist: null, album: null, isrc: null, url: null });

export function results(seq: number, provider: string | null, q: string, rows: { tracks?: unknown[]; artists?: unknown[]; albums?: unknown[] }, st: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: 'results', seq, provider, query: query(q), tracks: rows.tracks ?? [], artists: rows.artists ?? [], albums: rows.albums ?? [], status: st };
}

export function done(seq: number, q: string, st: Array<Record<string, unknown>>, more: { tracks?: boolean; artists?: boolean; albums?: boolean } = {}, offset = 0): Record<string, unknown> {
  const page = (has: boolean | undefined) => (has === undefined ? null : { offset, limit: 25, hasMore: has });
  return { type: 'done', seq, query: query(q), status: st, page: { tracks: page(more.tracks), artists: page(more.artists), albums: page(more.albums) }, totals: { tracks: 0, artists: 0, albums: 0 }, resolve: null };
}

export const ndjson = (chunks: unknown[]): string => chunks.map((c) => `${JSON.stringify(c)}\n`).join('');

export const json = (body: unknown, statusCode = 200) => ({ status: statusCode, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Stream chunks one by one, `gap` ms apart, the way the hub writes them as services answer. */
export async function fulfillStream(route: Route, chunks: unknown[]): Promise<void> {
  await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/x-ndjson' }, body: ndjson(chunks) });
}

export function collection(platform: Platform, kind: 'album' | 'playlist', id: string, title: string, tracks: unknown[], over: { total?: number | null; hasMore?: boolean; capped?: boolean; covers?: string[]; artworkUrl?: string | null; offset?: number; owner?: string | null } = {}): Record<string, unknown> {
  return {
    ref: { platform, kind, id, url: `https://${platform}.example/${kind}/${id}`, title, owner: over.owner ?? null },
    artworkUrl: over.artworkUrl ?? null,
    covers: over.covers ?? [],
    releaseDate: null,
    page: { tracks, offset: over.offset ?? 0, limit: 100, total: over.total ?? tracks.length, hasMore: over.hasMore ?? false, capped: over.capped ?? false },
  };
}

export function resolved(url: string, platform: Platform | null, kind: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { url, platform, kind, track: null, collection: null, artist: null, reason: null, resolvedAt: AT, ...over };
}

/** Nothing the browser engine asks may reach the internet. */
export async function stubServices(page: Page): Promise<void> {
  for (const u of ['**/itunes.apple.com/**', '**/api.deezer.com/**', '**/musicbrainz.org/**', '**/lrclib.net/**', '**/coverartarchive.org/**', '**/noembed.com/**', '**/www.youtube.com/oembed**', '**/soundcloud.com/oembed**']) {
    await page.route(u, (r) => r.abort());
  }
}

/** Point the player at a companion on this PC (as Settings ▸ Sources ▸ Connect does). */
export async function useCompanion(page: Page): Promise<void> {
  await page.evaluate((c) => {
    (window as unknown as { COMPANION: string }).COMPANION = c;
  }, COMPANION);
}

/** The asked-for URL's search parameters. */
export const params = (route: Route): URLSearchParams => new URL(route.request().url()).searchParams;

export async function searchFor(page: Page, q: string): Promise<void> {
  await page.fill('#q', q);
  await page.press('#q', 'Enter');
}
