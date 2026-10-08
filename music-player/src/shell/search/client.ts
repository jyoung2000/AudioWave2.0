/**
 * Where the player's music search gets its answers (DEC-039, NP-FIND-001/003).
 *
 * In order: the paired hub (`/api/v1/catalog/*`, the device credential), then the companion's helper
 * on this PC (`/helper/v1/catalog/*`, the page it vetted or its token), then — with no server at all —
 * the catalog engine itself, run in this page against the services that answer a browser: Apple's
 * iTunes API, MusicBrainz and LRCLIB send CORS headers; Deezer does not, so it is asked over JSONP
 * (measured 2026-10-06). YouTube and SoundCloud are searched with yt-dlp, which only the hub and the
 * companion have, and the browser engine says so in its status line.
 *
 * A server that cannot be reached is passed over for the next; a server that answers with a refusal
 * (a 400, a 422 with its reason) has answered, and that answer is what the person sees.
 */
import {
  CatalogAlbumDetail,
  CatalogArtistDetail,
  CatalogEnrichment,
  CatalogLyrics,
  CatalogResolveResult,
  HELPER_CATALOG_ROUTES,
  type CatalogProviderId,
  type CatalogSearchChunk,
  type CatalogSearchSection,
  type CatalogTrack,
} from '@now-playing/contracts';
import { readCatalogStream } from '@now-playing/domain/catalog';
import type { CatalogEngine, CatalogFetch, CatalogResponse } from '@now-playing/domain/catalog';

export interface SearchParams {
  q?: string;
  track?: string;
  artist?: string;
  album?: string;
  sections: readonly CatalogSearchSection[];
  providers: readonly CatalogProviderId[];
  offset: number;
  limit: number;
}

export type ClientKind = 'hub' | 'helper' | 'browser';

export interface CatalogClient {
  kind: ClientKind;
  /** Who answered, in words: "the hub TOWER", "the companion on this PC", "this browser". */
  label: string;
  search(params: SearchParams, signal: AbortSignal): AsyncGenerator<CatalogSearchChunk>;
  album(
    id: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogAlbumDetail>;
  artist(id: string, signal?: AbortSignal): Promise<CatalogArtistDetail>;
  resolve(
    url: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogResolveResult>;
  lyrics(track: CatalogTrack, signal?: AbortSignal): Promise<CatalogLyrics>;
  enrich(track: CatalogTrack, signal?: AbortSignal): Promise<CatalogEnrichment>;
}

/** The server could not be reached (or does not have the catalog yet): ask the next one. */
export class Unreachable extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'Unreachable';
  }
}

/** The server answered with a refusal, in words: show it. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refused';
  }
}

interface HubAccount {
  base: string;
  credentialId: string;
  secret: string;
  hubName?: string;
}

type ShellKv = { get(key: string): Promise<unknown> };

export async function hubAccount(): Promise<HubAccount | null> {
  const kv = (window as unknown as { kv?: ShellKv }).kv;
  if (!kv?.get) return null;
  try {
    const v = (await kv.get('player:hub')) as Partial<HubAccount> | null;
    return v && typeof v.base === 'string' && v.credentialId && v.secret ? (v as HubAccount) : null;
  } catch {
    return null;
  }
}

export function companionBase(): string | null {
  const c = (window as unknown as { COMPANION?: unknown }).COMPANION;
  return c ? String(c).replace(/\/$/, '') : null;
}

/** Only the web's own schemes travel from a server's answer into an href, an img or an audio src. */
export function webUrl(u: unknown): string | null {
  if (typeof u !== 'string' || !u || u.length > 2048) return null;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || p === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ requests */

function query(params: Record<string, string | number | undefined | null>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  return out.toString();
}

function searchQuery(p: SearchParams): string {
  return query({
    q: p.q,
    track: p.track,
    artist: p.artist,
    album: p.album,
    sections: p.sections.join(','),
    providers: p.providers.join(','),
    offset: p.offset,
    limit: p.limit,
  });
}

/** Waits `ms` for the response headers; the body (a stream) may take as long as it takes. */
async function request(
  url: string,
  headers: Record<string, string>,
  ms: number,
  outer?: AbortSignal,
): Promise<Response> {
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    // The outer signal stays wired after the headers: aborting a search stops its stream too.
    return await fetch(url, { headers, signal: ctl.signal, cache: 'no-store' });
  } catch {
    outer?.removeEventListener('abort', onAbort);
    if (outer?.aborted) throw new DOMException('aborted', 'AbortError');
    throw new Unreachable(`${new URL(url).host} did not answer`);
  } finally {
    clearTimeout(timer);
  }
}

async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: unknown;
      message?: unknown;
      title?: unknown;
    };
    const said = body.detail ?? body.message ?? body.title;
    if (typeof said === 'string' && said) return said.slice(0, 400);
  } catch {
    /* no body worth reading */
  }
  return `It answered ${response.status}.`;
}

async function readJson<T>(
  response: Response,
  parse: (v: unknown) => T,
  missing: 'unreachable' | 'refused',
): Promise<T> {
  if (response.status === 404 && missing === 'unreachable')
    throw new Unreachable('no catalog here', 404);
  if (response.status >= 500 && response.status !== 503)
    throw new Unreachable(await reason(response), response.status);
  if (!response.ok) throw new Refused(await reason(response));
  return parse(await response.json());
}

/** A server's catalog, reached over HTTP: the hub's and the helper's answer in the same shapes. */
function httpClient(
  kind: 'hub' | 'helper',
  label: string,
  base: string,
  paths: Record<keyof typeof HELPER_CATALOG_ROUTES, string>,
  headers: Record<string, string>,
): CatalogClient {
  const get = async <T>(
    path: string,
    q: string,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
    ms = 30_000,
  ): Promise<T> =>
    readJson(await request(`${base}${path}?${q}`, headers, ms, signal), parse, 'refused');
  return {
    kind,
    label,
    async *search(params, signal) {
      const response = await request(
        `${base}${paths.search}?${searchQuery(params)}`,
        headers,
        kind === 'hub' ? 6000 : 4000,
        signal,
      );
      if (response.status === 404) throw new Unreachable('no catalog here', 404);
      if (!response.ok || !response.body) {
        if (response.status >= 500 && response.status !== 503)
          throw new Unreachable(await reason(response), response.status);
        throw new Refused(await reason(response));
      }
      yield* readCatalogStream(response.body);
    },
    album: (id, offset, limit, signal) =>
      get(paths.album, query({ id, offset, limit }), (v) => CatalogAlbumDetail.parse(v), signal),
    artist: (id, signal) =>
      get(
        paths.artist,
        query({ id, topLimit: 10, albumsLimit: 25 }),
        (v) => CatalogArtistDetail.parse(v),
        signal,
      ),
    // Spotify goes through spotDL, which takes 20-50 s; the rest answer in seconds.
    resolve: (url, offset, limit, signal) =>
      get(
        paths.resolve,
        query({ url, offset, limit }),
        (v) => CatalogResolveResult.parse(v),
        signal,
        /spotify\.com\//.test(url) ? 120_000 : 60_000,
      ),
    lyrics: (t, signal) =>
      get(
        paths.lyrics,
        query({
          title: t.title,
          artist: t.artists[0] ?? t.artist,
          album: t.album,
          durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
        }),
        (v) => CatalogLyrics.parse(v),
        signal,
      ),
    enrich: (t, signal) =>
      get(
        paths.enrich,
        t.isrc
          ? query({ isrc: t.isrc, links: 1 })
          : query({
              title: t.title,
              artist: t.artists[0] ?? t.artist,
              durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
              links: 1,
            }),
        (v) => CatalogEnrichment.parse(v),
        signal,
      ),
  };
}

const HUB_PATHS = {
  search: '/api/v1/catalog/search',
  album: '/api/v1/catalog/album',
  artist: '/api/v1/catalog/artist',
  resolve: '/api/v1/catalog/resolve',
  lyrics: '/api/v1/catalog/lyrics',
  enrich: '/api/v1/catalog/enrich',
};

/* ------------------------------------------------- the engine, in this page */

let jsonpN = 0;

/** Deezer answers a browser only over JSONP: no CORS headers on api.deezer.com (2026-10-06). */
export function jsonp(url: string, ms: number, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cb = `__npCatalog${++jsonpN}`;
    const el = document.createElement('script');
    let done = false;
    const w = window as unknown as Record<string, unknown>;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
      delete w[cb];
      el.remove();
    };
    function fail(): void {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('jsonp'));
    }
    const timer = setTimeout(fail, ms);
    signal?.addEventListener('abort', fail, { once: true });
    w[cb] = (d: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(d);
    };
    el.onerror = fail;
    el.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.appendChild(el);
  });
}

const answered = (body: unknown): CatalogResponse => ({
  status: 200,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * The browser's network for the engine. Only `Accept` is sent: a `User-Agent` (which the engine
 * offers MusicBrainz and LRCLIB) is not a CORS-safelisted header and would cost a refused preflight.
 */
const browserFetch: CatalogFetch = async (url, init) => {
  const host = new URL(url).hostname;
  if (host === 'api.deezer.com') return answered(await jsonp(url, 9000, init.signal));
  try {
    const res = await fetch(url, {
      signal: init.signal,
      headers: { Accept: 'application/json' },
      ...(init.redirect ? { redirect: init.redirect } : {}),
    });
    // A redirect left unfollowed is opaque to a page (status 0): say what it was, a redirect.
    return res.type === 'opaqueredirect' ? { ...answered(null), status: 307 } : res;
  } catch (err) {
    // iTunes has answered without CORS on some storefronts; it speaks JSONP too (`callback`).
    if (host === 'itunes.apple.com' && !init.signal.aborted)
      return answered(await jsonpCallback(url, 9000, init.signal));
    throw err;
  }
};

function jsonpCallback(url: string, ms: number, signal: AbortSignal): Promise<unknown> {
  // iTunes takes `callback` alone; the Deezer `output=jsonp` parameter it ignores.
  return jsonp(url, ms, signal);
}

let engine: Promise<CatalogEngine> | null = null;
function browserEngine(): Promise<CatalogEngine> {
  engine ??= import('@now-playing/domain/catalog').then(
    (m) =>
      new m.CatalogEngine({
        fetch: browserFetch,
        userAgent: 'Airwave',
        timeouts: { itunes: 9000, deezer: 9000, musicbrainz: 10_000, lrclib: 10_000 },
        crossLinkBudgetMs: 4000,
      }),
  );
  return engine;
}

function asRefused(err: unknown): Error {
  const e = err as { message?: unknown; code?: unknown };
  return new Refused(
    typeof e.message === 'string' && e.message ? e.message : 'The catalog could not answer.',
  );
}

const browserClient: CatalogClient = {
  kind: 'browser',
  label: 'this browser',
  async *search(params, signal) {
    const e = await browserEngine();
    yield* e.search(
      {
        q: params.q,
        track: params.track,
        artist: params.artist,
        album: params.album,
        sections: params.sections,
        providers: params.providers,
        offset: params.offset,
        limit: params.limit,
      },
      signal,
    );
  },
  album: async (id, offset, limit, signal) =>
    (await browserEngine())
      .album(id, offset, limit, signal)
      .catch((e: unknown) => Promise.reject(asRefused(e))),
  artist: async (id, signal) =>
    (await browserEngine())
      .artist(id, { topLimit: 10, albumsLimit: 25 }, signal)
      .catch((e: unknown) => Promise.reject(asRefused(e))),
  resolve: async (url, offset, limit, signal) => {
    const result = await (
      await browserEngine()
    )
      .resolve(url, offset, limit, signal)
      .catch((e: unknown) => Promise.reject(asRefused(e)));
    // YouTube and SoundCloud links need yt-dlp to read. Their oEmbed (relayed by noembed.com, which
    // sends CORS headers) still names the song, so a pasted link says what it is in a browser too.
    if (
      result.kind === 'unsupported' &&
      (result.platform === 'youtube' ||
        result.platform === 'youtube-music' ||
        result.platform === 'soundcloud')
    ) {
      const named = await oembedTrack(url, result.platform, signal);
      if (named) return { ...result, kind: 'track', track: named, reason: null };
    }
    return result;
  },
  lyrics: async (t, signal) =>
    (await browserEngine())
      .lyrics(
        {
          title: t.title,
          artist: t.artists[0] ?? t.artist,
          album: t.album ?? undefined,
          durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
        },
        signal,
      )
      .catch((e: unknown) => Promise.reject(asRefused(e))),
  enrich: async (t, signal) =>
    (await browserEngine())
      .enrich(
        {
          isrc: t.isrc,
          title: t.title,
          artist: t.artists[0] ?? t.artist,
          durationMs: t.durationMs,
        },
        signal,
      )
      .catch((e: unknown) => Promise.reject(asRefused(e))),
};

async function oembedTrack(
  url: string,
  platform: 'youtube' | 'youtube-music' | 'soundcloud',
  signal?: AbortSignal,
): Promise<CatalogTrack | null> {
  const own =
    platform === 'soundcloud'
      ? `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`
      : `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  for (const endpoint of [own, `https://noembed.com/embed?url=${encodeURIComponent(url)}`]) {
    try {
      const r = await request(endpoint, {}, 8000, signal);
      if (!r.ok) continue;
      const d = (await r.json()) as {
        title?: unknown;
        author_name?: unknown;
        thumbnail_url?: unknown;
        error?: unknown;
      };
      if (d.error || typeof d.title !== 'string' || !d.title) continue;
      const artist = typeof d.author_name === 'string' ? d.author_name.slice(0, 300) : '';
      return {
        id: `${platform}:${url}`.slice(0, 260),
        title: d.title.slice(0, 300),
        artist,
        artists: artist ? [artist] : [],
        album: null,
        albumArtist: null,
        durationMs: null,
        isrc: null,
        artworkUrl: webUrl(d.thumbnail_url),
        releaseDate: null,
        year: null,
        trackNumber: null,
        discNumber: null,
        bpm: null,
        explicit: null,
        genre: null,
        label: null,
        sources: [{ platform, id: null, url, previewUrl: null, matchedBy: 'link' }],
        rank: 0,
      };
    } catch {
      /* the next relay */
    }
  }
  return null;
}

/* ------------------------------------------------------------- the order */

/** Every client that may answer, best first. The browser is always last and always there. */
export async function clients(): Promise<CatalogClient[]> {
  const out: CatalogClient[] = [];
  const acct = await hubAccount();
  if (acct) {
    out.push(
      httpClient(
        'hub',
        `the hub ${acct.hubName || ''}`.trim(),
        acct.base.replace(/\/$/, ''),
        HUB_PATHS,
        {
          Authorization: `Bearer ${acct.credentialId}.${acct.secret}`,
          Accept: 'application/json, application/x-ndjson',
        },
      ),
    );
  }
  const helper = companionBase();
  if (helper) {
    const token = document.querySelector<HTMLMetaElement>('meta[name="np-helper-token"]')?.content;
    out.push(
      httpClient(
        'helper',
        'the companion on this PC',
        helper,
        HELPER_CATALOG_ROUTES,
        token ? { 'x-helper-token': token } : {},
      ),
    );
  }
  out.push(browserClient);
  return out;
}

/**
 * Ask each client in turn until one answers. `Unreachable` moves on; anything else is the answer.
 * Resolves with the answer and who gave it.
 */
export async function ask<T>(
  work: (c: CatalogClient) => Promise<T>,
): Promise<{ value: T; client: CatalogClient }> {
  const list = await clients();
  let last: unknown = null;
  for (const c of list) {
    try {
      return { value: await work(c), client: c };
    } catch (err) {
      if (err instanceof Unreachable) {
        last = err;
        continue;
      }
      throw err;
    }
  }
  throw last instanceof Error ? last : new Error('Nothing could be reached');
}

/* ------------------------------------------------ a hub without the catalog */

/** The hub's older `/api/v1/search` row, before the catalog (2026-10-06): songs only. */
interface LegacyRow {
  id?: unknown;
  kind?: unknown;
  provider?: unknown;
  providerId?: unknown;
  title?: unknown;
  artistName?: unknown;
  albumName?: unknown;
  durationMs?: unknown;
  artworkUrl?: unknown;
  canonicalUrl?: unknown;
  previewUrl?: unknown;
  featuredArtists?: unknown;
  genres?: unknown;
  bpm?: unknown;
  identity?: { matchConfidence?: unknown } | null;
}

const LEGACY_PLATFORMS = {
  youtube: 'youtube',
  soundcloud: 'soundcloud',
  spotify: 'spotify',
  bandcamp: 'bandcamp',
} as const;

/**
 * A hub that predates the catalog answers its songs search. Its rows become catalog tracks: below a
 * match confidence of 0.5 the hub itself refused to guess, so the row keeps the platform's own words
 * (no album, no features, no genre).
 */
export async function legacyHubSearch(
  q: string,
  signal: AbortSignal,
): Promise<CatalogTrack[] | null> {
  const acct = await hubAccount();
  if (!acct) return null;
  const r = await request(
    `${acct.base.replace(/\/$/, '')}/api/v1/search?scope=songs&q=${encodeURIComponent(q)}`,
    { Authorization: `Bearer ${acct.credentialId}.${acct.secret}` },
    5000,
    signal,
  );
  if (!r.ok) throw new Unreachable(await reason(r), r.status);
  const body = (await r.json()) as { results?: LegacyRow[] };
  const out: CatalogTrack[] = [];
  for (const [i, x] of (body.results ?? []).entries()) {
    if (!x || x.kind !== 'track' || typeof x.title !== 'string' || out.length >= 25) continue;
    const conf =
      typeof x.identity?.matchConfidence === 'number' ? x.identity.matchConfidence : null;
    const sure = conf === null || conf >= 0.5;
    const feat =
      sure && Array.isArray(x.featuredArtists)
        ? x.featuredArtists.filter((f): f is string => typeof f === 'string').slice(0, 3)
        : [];
    const artistName = typeof x.artistName === 'string' ? x.artistName : '';
    const platform = LEGACY_PLATFORMS[x.provider as keyof typeof LEGACY_PLATFORMS] ?? 'youtube';
    const genre =
      sure && Array.isArray(x.genres) && typeof x.genres[0] === 'string' ? x.genres[0] : null;
    out.push({
      id: typeof x.id === 'string' ? x.id.slice(0, 260) : `hub:${i}`,
      title: x.title.slice(0, 300),
      artist: artistName + (feat.length ? ` feat. ${feat.join(', ')}` : ''),
      artists: [artistName, ...feat].filter(Boolean),
      album: sure && typeof x.albumName === 'string' && x.albumName ? x.albumName : null,
      albumArtist: null,
      durationMs:
        typeof x.durationMs === 'number' && x.durationMs > 0 ? Math.round(x.durationMs) : null,
      isrc: null,
      artworkUrl: webUrl(x.artworkUrl),
      releaseDate: null,
      year: null,
      trackNumber: null,
      discNumber: null,
      bpm: typeof x.bpm === 'number' && x.bpm > 0 ? x.bpm : null,
      explicit: null,
      genre,
      label: null,
      sources: [
        {
          platform,
          id: typeof x.providerId === 'string' ? x.providerId : null,
          url: webUrl(x.canonicalUrl) ?? '',
          previewUrl: webUrl(x.previewUrl),
          matchedBy: 'search',
        },
      ],
      rank: 25 - i,
    });
  }
  return out;
}
