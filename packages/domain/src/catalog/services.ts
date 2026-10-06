/**
 * The services that are not searched but asked about one song: lyrics (LRCLIB) and the song's homes
 * on other platforms (SongLink/Odesli, with a key).
 *
 * SongLink closed its keyless API in 2026 (measured 2026-10-06: `401 PUBLIC_API_ACCESS_DEPRECATED`).
 * Keyless-first means it cannot be the way links are found, only a way to find more: without a key
 * the catalog uses MusicBrainz's links and Deezer's ISRC lookup (see `engine.ts`); with one, SongLink
 * adds what those miss, within its published 10 requests a minute.
 */
import type { CatalogLyrics, CatalogPlatform, CatalogSource } from '@now-playing/contracts';
import { arr, CatalogHttpError, getJson, isObject, num, str, webUrl, type CatalogFetch, type Json } from './http.js';
import { Budget, type Now } from './limits.js';
import { parseMusicLink } from './query.js';

export const LRCLIB_API = 'https://lrclib.net/api';
export const ODESLI_API = 'https://api.song.link/v1-alpha.1/links';

/** At most this many characters of lyrics are kept: a song, not a book. */
const LYRICS_MAX = 20_000;

/** Multi-line text with its line breaks kept (unlike `str`, which would join LRC lines). */
function lines(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\r\n?/g, '\n').trim().slice(0, LYRICS_MAX) : null;
}

function lyricsFrom(row: Json): CatalogLyrics {
  const synced = lines(row['syncedLyrics']);
  const plain = lines(row['plainLyrics']);
  return {
    found: Boolean(synced || plain || row['instrumental'] === true),
    source: 'lrclib',
    id: num(row['id']) !== null ? Math.round(num(row['id'])!) : null,
    instrumental: row['instrumental'] === true,
    synced,
    plain,
    trackName: str(row['trackName']),
    artistName: str(row['artistName']),
    durationSec: num(row['duration']),
  };
}

export const NO_LYRICS: CatalogLyrics = { found: false, source: 'lrclib', id: null, instrumental: false, synced: null, plain: null, trackName: null, artistName: null, durationSec: null };

export class LrclibClient {
  constructor(
    private readonly fetchImpl: CatalogFetch,
    private readonly userAgent: string,
    readonly timeoutMs = 10_000,
  ) {}

  /**
   * The exact match first (title, artist, album and duration, which is how LRCLIB keys a song);
   * failing that, a search, taking the closest duration among rows for the same artist.
   */
  async lyrics(input: { title: string; artist: string; album?: string | undefined; durationSec?: number | undefined }, signal?: AbortSignal): Promise<CatalogLyrics> {
    const headers = { 'User-Agent': this.userAgent };
    const params = new URLSearchParams({ track_name: input.title, artist_name: input.artist });
    if (input.album) params.set('album_name', input.album);
    if (input.durationSec) params.set('duration', String(Math.round(input.durationSec)));
    if (input.album && input.durationSec) {
      const exact = await getJson(this.fetchImpl, `${LRCLIB_API}/get?${params}`, { timeoutMs: this.timeoutMs, signal, headers, accept: [404] });
      if (exact.status !== 404 && isObject(exact.body)) {
        const found = lyricsFrom(exact.body);
        if (found.found) return found;
      }
    }
    const search = new URLSearchParams({ track_name: input.title, artist_name: input.artist });
    const { body } = await getJson(this.fetchImpl, `${LRCLIB_API}/search?${search}`, { timeoutMs: this.timeoutMs, signal, headers });
    const rows = (Array.isArray(body) ? body : []).filter(isObject).slice(0, 50).map(lyricsFrom).filter((l) => l.found);
    if (!rows.length) return NO_LYRICS;
    const target = input.durationSec ?? null;
    const scored = rows.map((row, i) => ({ row, i, off: target !== null && row.durationSec !== null ? Math.abs(row.durationSec - target) : 30, synced: row.synced ? 0 : 1 }));
    // Within five seconds of the song, a synced text beats a plain one; past that, nearest wins.
    scored.sort((a, b) => (Math.min(a.off, 5) === Math.min(b.off, 5) ? a.synced - b.synced : a.off - b.off) || a.i - b.i);
    const best = scored[0]!;
    return target !== null && best.off > 10 ? NO_LYRICS : best.row;
  }
}

/** SongLink's platform keys, as the catalog names them. */
const ODESLI_PLATFORMS: Record<string, CatalogPlatform> = {
  spotify: 'spotify',
  appleMusic: 'apple-music',
  itunes: 'apple-music',
  youtube: 'youtube',
  youtubeMusic: 'youtube-music',
  deezer: 'deezer',
  tidal: 'tidal',
  amazonMusic: 'amazon-music',
  soundcloud: 'soundcloud',
  bandcamp: 'bandcamp',
  qobuz: 'qobuz',
};

export interface OdesliAnswer {
  title: string | null;
  artist: string | null;
  artworkUrl: string | null;
  kind: 'song' | 'album' | null;
  sources: CatalogSource[];
}

export class OdesliClient {
  private readonly budget: Budget;

  constructor(
    private readonly fetchImpl: CatalogFetch,
    private readonly key: () => string | null,
    now: Now = Date.now,
    readonly timeoutMs = 10_000,
  ) {
    // 10 a minute is the keyless allowance SongLink published; a key raises it, so stay modest.
    this.budget = new Budget(10, 60_000, now);
  }

  get configured(): boolean {
    return Boolean(this.key());
  }

  /** The song's (or album's) other homes, or null without a key. A refusal is a `CatalogHttpError`. */
  async links(url: string, signal?: AbortSignal): Promise<OdesliAnswer | null> {
    const key = this.key();
    if (!key) return null;
    const turn = this.budget.take();
    if (!turn.ok) throw new CatalogHttpError('SongLink allows ten lookups a minute; it is resting', 'rate-limited', 429, turn.retryAt - Date.now());
    const params = new URLSearchParams({ url, key });
    const { body } = await getJson(this.fetchImpl, `${ODESLI_API}?${params}`, { timeoutMs: this.timeoutMs, signal });
    return parseOdesli(body);
  }
}

export function parseOdesli(body: unknown): OdesliAnswer | null {
  if (!isObject(body) || !isObject(body['linksByPlatform'])) return null;
  const sources: CatalogSource[] = [];
  for (const [key, value] of Object.entries(body['linksByPlatform'])) {
    const platform = ODESLI_PLATFORMS[key];
    const url = isObject(value) ? webUrl(value['url']) : null;
    if (!platform || !url || sources.some((s) => s.platform === platform)) continue;
    const link = parseMusicLink(url);
    sources.push({ platform, id: link?.id ?? null, url, previewUrl: null, matchedBy: 'odesli' });
  }
  const entities = isObject(body['entitiesByUniqueId']) ? body['entitiesByUniqueId'] : {};
  const primary = str(body['entityUniqueId'], 200);
  const entity = (primary && isObject(entities[primary]) ? entities[primary] : arr(Object.values(entities))[0]) as Json | undefined;
  const type = str(entity?.['type']);
  return { title: str(entity?.['title']), artist: str(entity?.['artistName']), artworkUrl: webUrl(entity?.['thumbnailUrl']), kind: type === 'song' || type === 'album' ? type : null, sources };
}
