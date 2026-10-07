/**
 * Apple's iTunes Search and Lookup APIs: keyless, songs with 30-second previews, albums, artists.
 *
 * Apple asks for about twenty calls a minute from one address; the provider keeps its own budget
 * and rests (`cooling-down` with the time) rather than being refused. It has no ISRC lookup and no
 * artist pictures, and says so by not being asked.
 */
import type { CatalogAlbum, CatalogArtist, CatalogQuery, CatalogSearchSection, CatalogSection, CatalogTrack } from '@now-playing/contracts';
import { arr, calendarDate, getJson, num, posInt, str, webUrl, yearOf, type CatalogFetch, type Json } from '../http.js';
import { Budget, type Now } from '../limits.js';
import { ProviderResting, emptyResult, type CatalogProvider, type ProviderResult, type ProviderSearchOptions } from '../provider.js';

export const ITUNES_SEARCH = 'https://itunes.apple.com/search';
export const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';
/** Apple's published guidance: roughly 20 calls per minute. */
export const ITUNES_BUDGET = { calls: 20, windowMs: 60_000 };

/** The 100 px artwork Apple lists, asked for at 600 px (the same image, rendered larger). */
export function itunesArtwork(value: unknown, size = 600): string | null {
  const url = webUrl(value);
  return url ? url.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}x${size}bb.$1`) : null;
}

function explicit(value: unknown): boolean | null {
  return value === 'explicit' ? true : value === 'notExplicit' || value === 'cleaned' ? false : null;
}

export function itunesTrack(row: Json): CatalogTrack | null {
  const id = num(row['trackId']);
  const title = str(row['trackName']);
  const artist = str(row['artistName']);
  const url = webUrl(row['trackViewUrl']);
  if (id === null || !title || !artist || !url) return null;
  const releaseDate = calendarDate(row['releaseDate']);
  return {
    id: `apple-music:${id}`,
    title,
    artist,
    artists: [artist],
    album: str(row['collectionName']),
    albumArtist: str(row['collectionArtistName']) ?? str(row['artistName']),
    durationMs: posInt(row['trackTimeMillis']),
    isrc: null,
    artworkUrl: itunesArtwork(row['artworkUrl100']),
    releaseDate,
    year: yearOf(releaseDate),
    trackNumber: posInt(row['trackNumber']),
    discNumber: posInt(row['discNumber']),
    bpm: null,
    explicit: explicit(row['trackExplicitness']),
    genre: str(row['primaryGenreName'], 100),
    label: null,
    sources: [{ platform: 'apple-music', id: String(id), url: url.replace(/[?&]uo=\d+$/, ''), previewUrl: webUrl(row['previewUrl']), matchedBy: 'search' }],
    rank: 0,
  };
}

export function itunesAlbum(row: Json): CatalogAlbum | null {
  const id = num(row['collectionId']);
  const title = str(row['collectionName']);
  const url = webUrl(row['collectionViewUrl']);
  if (id === null || !title || !url) return null;
  const releaseDate = calendarDate(row['releaseDate']);
  return {
    id: `apple-music:${id}`,
    title,
    artist: str(row['artistName']),
    artworkUrl: itunesArtwork(row['artworkUrl100']),
    releaseDate,
    year: yearOf(releaseDate),
    trackCount: posInt(row['trackCount']),
    label: null,
    genre: str(row['primaryGenreName'], 100),
    explicit: explicit(row['collectionExplicitness']),
    upc: null,
    sources: [{ platform: 'apple-music', id: String(id), url: url.replace(/[?&]uo=\d+$/, ''), previewUrl: null, matchedBy: 'search' }],
    rank: 0,
  };
}

export function itunesArtist(row: Json): CatalogArtist | null {
  const id = num(row['artistId']);
  const name = str(row['artistName']);
  const url = webUrl(row['artistLinkUrl']) ?? webUrl(row['artistViewUrl']);
  if (id === null || !name || !url) return null;
  return { id: `apple-music:${id}`, name, pictureUrl: null, albumCount: null, fans: null, genre: str(row['primaryGenreName'], 100), sources: [{ platform: 'apple-music', id: String(id), url: url.replace(/[?&]uo=\d+$/, ''), previewUrl: null, matchedBy: 'search' }], rank: 0 };
}

export interface ItunesOptions {
  fetch: CatalogFetch;
  /** The storefront: results, prices and links are per country. */
  country?: string | undefined;
  now?: Now;
  timeoutMs?: number;
}

export class ItunesClient {
  private readonly budget: Budget;
  readonly country: string;
  readonly timeoutMs: number;

  constructor(private readonly options: ItunesOptions) {
    this.budget = new Budget(ITUNES_BUDGET.calls, ITUNES_BUDGET.windowMs, options.now ?? Date.now);
    this.country = (options.country ?? 'US').toUpperCase();
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /** One call, within Apple's budget. */
  async get(base: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<Json[]> {
    const turn = this.budget.take();
    if (!turn.ok) throw new ProviderResting('Apple’s search allows about 20 searches a minute; it is resting', turn.retryAt);
    const query = new URLSearchParams({ country: this.country, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    const { body } = await getJson(this.options.fetch, `${base}?${query}`, { timeoutMs: this.timeoutMs, signal });
    return arr((body as Json | null)?.['results']);
  }

  /** An album and its songs, in order. */
  async album(id: string, signal?: AbortSignal): Promise<{ album: CatalogAlbum; tracks: CatalogTrack[] } | null> {
    const rows = await this.get(ITUNES_LOOKUP, { id, entity: 'song', limit: 200 }, signal);
    const head = rows.find((r) => r['wrapperType'] === 'collection');
    const album = head ? itunesAlbum(head) : null;
    if (!album) return null;
    const tracks = rows
      .filter((r) => r['wrapperType'] === 'track')
      .map(itunesTrack)
      .filter((t): t is CatalogTrack => t !== null)
      .sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
    return { album, tracks };
  }

  async track(id: string, signal?: AbortSignal): Promise<CatalogTrack | null> {
    const rows = await this.get(ITUNES_LOOKUP, { id, entity: 'song' }, signal);
    const row = rows.find((r) => r['wrapperType'] === 'track' && String(r['trackId']) === id) ?? rows.find((r) => r['wrapperType'] === 'track');
    return row ? itunesTrack(row) : null;
  }

  async artist(id: string, albumLimit: number, topLimit: number, signal?: AbortSignal): Promise<{ artist: CatalogArtist; albums: CatalogAlbum[]; topTracks: CatalogTrack[] } | null> {
    const albums = await this.get(ITUNES_LOOKUP, { id, entity: 'album', limit: Math.min(albumLimit, 200) }, signal);
    const head = albums.find((r) => r['wrapperType'] === 'artist');
    const artist = head ? itunesArtist(head) : null;
    if (!artist) return null;
    const songs = await this.get(ITUNES_LOOKUP, { id, entity: 'song', limit: Math.min(topLimit, 200) }, signal).catch(() => [] as Json[]);
    const list = albums.filter((r) => r['wrapperType'] === 'collection').map(itunesAlbum).filter((a): a is CatalogAlbum => a !== null);
    const firstArt = list.find((a) => a.artworkUrl)?.artworkUrl ?? null;
    return { artist: { ...artist, albumCount: list.length || null, pictureUrl: artist.pictureUrl ?? firstArt }, albums: list, topTracks: songs.filter((r) => r['wrapperType'] === 'track').map(itunesTrack).filter((t): t is CatalogTrack => t !== null) };
  }
}

const ENTITY: Record<CatalogSection, string> = { tracks: 'song', artists: 'musicArtist', albums: 'album' };

export class ItunesProvider implements CatalogProvider {
  readonly id = 'itunes' as const;
  readonly sections: readonly CatalogSearchSection[] = ['tracks', 'artists', 'albums'];
  readonly timeoutMs: number;

  constructor(readonly client: ItunesClient) {
    this.timeoutMs = client.timeoutMs + 500;
  }

  supports(query: CatalogQuery): boolean {
    return query.kind === 'text' || query.kind === 'advanced';
  }

  async search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult> {
    const out = emptyResult();
    const sections = options.sections.filter((s): s is CatalogSection => s in ENTITY);
    // One call per section, side by side. A section the budget refused is left out; only when every
    // section was refused (or failed) does the provider report it.
    const settled = await Promise.allSettled(
      sections.map((section) => {
        const params: Record<string, string | number> = { term: query.text, media: 'music', entity: ENTITY[section], limit: options.limit, offset: options.offset };
        if (query.kind === 'advanced' && section === 'tracks' && query.track && !query.artist && !query.album) params['attribute'] = 'songTerm';
        return this.client.get(ITUNES_SEARCH, params, options.signal);
      }),
    );
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      const section = sections[i]!;
      const rows = result.value;
      out.full[section] = rows.length >= options.limit;
      if (section === 'tracks') out.tracks = rows.map(itunesTrack).filter((t): t is CatalogTrack => t !== null);
      if (section === 'albums') out.albums = rows.map(itunesAlbum).filter((a): a is CatalogAlbum => a !== null);
      if (section === 'artists') out.artists = rows.map(itunesArtist).filter((a): a is CatalogArtist => a !== null);
    });
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && settled.every((r) => r.status === 'rejected')) throw failed.reason;
    return out;
  }
}
