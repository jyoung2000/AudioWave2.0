/**
 * Deezer's public API (api.deezer.com): keyless songs with ISRCs and 30-second previews, artists
 * with pictures, albums with labels, playlists, an ISRC lookup with tempo.
 *
 * Deezer answers some errors with status 200 and an `error` object; code 4 is its quota (50 calls
 * in 5 seconds), read as a rate limit. Its field syntax (`artist:"…" track:"…"`) is used for the
 * advanced fields, and when that finds nothing — measured 2026-10-06, `artist:` matched nothing at
 * all — the same words are asked as plain text, so a broken filter costs precision, not answers.
 */
import type { CatalogAlbum, CatalogArtist, CatalogPlatform, CatalogQuery, CatalogSection, CatalogTrack } from '@now-playing/contracts';
import { arr, calendarDate, CatalogHttpError, getJson, isObject, num, posInt, str, webUrl, yearOf, type CatalogFetch, type Json } from '../http.js';
import { emptyResult, type CatalogProvider, type ProviderResult, type ProviderSearchOptions } from '../provider.js';

export const DEEZER_API = 'https://api.deezer.com';

function dzCover(md5: unknown, kind: 'cover' | 'artist' | 'playlist' = 'cover'): string | null {
  return typeof md5 === 'string' && /^[0-9a-f]{32}$/.test(md5) ? `https://cdn-images.dzcdn.net/images/${kind}/${md5}/1000x1000-000000-80-0-0.jpg` : null;
}

const source = (kind: 'track' | 'album' | 'artist' | 'playlist', id: number, preview: string | null = null): { platform: CatalogPlatform; id: string; url: string; previewUrl: string | null; matchedBy: 'search' } => ({
  platform: 'deezer',
  id: String(id),
  url: `https://www.deezer.com/${kind}/${id}`,
  previewUrl: preview,
  matchedBy: 'search',
});

/** A Deezer track object, from search, a lookup, an album or a playlist. `album` fills what a listing leaves out. */
export function deezerTrack(row: Json, album: CatalogAlbum | null = null): CatalogTrack | null {
  const id = num(row['id']);
  const title = str(row['title']);
  const artistObj = isObject(row['artist']) ? row['artist'] : null;
  const artist = str(artistObj?.['name']);
  if (id === null || !title || !artist || row['readable'] === false) return null;
  const albumObj = isObject(row['album']) ? row['album'] : null;
  const contributors = arr(row['contributors'])
    .map((c) => str(c['name']))
    .filter((n): n is string => Boolean(n));
  const releaseDate = calendarDate(row['release_date']) ?? album?.releaseDate ?? null;
  const isrc = str(row['isrc'], 12);
  const bpm = num(row['bpm']);
  const explicit = typeof row['explicit_lyrics'] === 'boolean' ? (row['explicit_lyrics'] as boolean) : null;
  return {
    id: `deezer:${id}`,
    title,
    artist,
    artists: contributors.length ? contributors : [artist],
    album: str(albumObj?.['title']) ?? album?.title ?? null,
    albumArtist: album?.artist ?? null,
    durationMs: posInt(row['duration']) !== null ? posInt(row['duration'])! * 1000 : null,
    isrc: isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null,
    artworkUrl: webUrl(albumObj?.['cover_xl']) ?? dzCover(row['md5_image']) ?? album?.artworkUrl ?? null,
    releaseDate,
    year: yearOf(releaseDate),
    trackNumber: posInt(row['track_position']),
    discNumber: posInt(row['disk_number']),
    bpm: bpm !== null && bpm > 0 ? bpm : null,
    explicit,
    genre: album?.genre ?? null,
    label: album?.label ?? null,
    sources: [source('track', id, webUrl(row['preview']))],
    rank: 0,
  };
}

export function deezerAlbum(row: Json): CatalogAlbum | null {
  const id = num(row['id']);
  const title = str(row['title']);
  if (id === null || !title) return null;
  const artistObj = isObject(row['artist']) ? row['artist'] : null;
  const genres = arr(isObject(row['genres']) ? row['genres']['data'] : null);
  const releaseDate = calendarDate(row['release_date']);
  return {
    id: `deezer:${id}`,
    title,
    artist: str(artistObj?.['name']),
    artworkUrl: webUrl(row['cover_xl']) ?? dzCover(row['md5_image']),
    releaseDate,
    year: yearOf(releaseDate),
    trackCount: posInt(row['nb_tracks']),
    label: str(row['label']),
    genre: str(genres[0]?.['name'], 100),
    explicit: typeof row['explicit_lyrics'] === 'boolean' ? (row['explicit_lyrics'] as boolean) : null,
    upc: str(row['upc'], 40),
    sources: [source('album', id)],
    rank: 0,
  };
}

export function deezerArtist(row: Json): CatalogArtist | null {
  const id = num(row['id']);
  const name = str(row['name']);
  if (id === null || !name) return null;
  return { id: `deezer:${id}`, name, pictureUrl: webUrl(row['picture_xl']) ?? webUrl(row['picture_big']), albumCount: posInt(row['nb_album']), fans: num(row['nb_fan']) !== null ? Math.round(num(row['nb_fan'])!) : null, genre: null, sources: [source('artist', id)], rank: 0 };
}

/** A Lucene-ish quote for Deezer's field syntax: no quotes inside, no runaway length. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').trim().slice(0, 120)}"`;
}

export function deezerAdvanced(query: CatalogQuery): string {
  const parts: string[] = [];
  if (query.track) parts.push(`track:${quoted(query.track)}`);
  if (query.artist) parts.push(`artist:${quoted(query.artist)}`);
  if (query.album) parts.push(`album:${quoted(query.album)}`);
  return parts.join(' ');
}

export interface DeezerPlaylist {
  id: string;
  title: string;
  owner: string | null;
  artworkUrl: string | null;
  total: number | null;
  url: string;
}

/** Rows per call when paging a long album or playlist. */
export const DEEZER_PAGE = 100;

export class DeezerClient {
  constructor(
    private readonly fetchImpl: CatalogFetch,
    readonly timeoutMs = 8000,
  ) {}

  /** One call. Deezer's in-body errors become what they are: quota, not found, or a failure. */
  async get(path: string, signal?: AbortSignal): Promise<Json | null> {
    const { body } = await getJson(this.fetchImpl, `${DEEZER_API}${path}`, { timeoutMs: this.timeoutMs, signal, accept: [404] });
    if (!isObject(body)) throw new CatalogHttpError('Deezer sent something unexpected', 'parse');
    const error = isObject(body['error']) ? body['error'] : null;
    if (error) {
      const code = num(error['code']);
      if (code === 4) throw new CatalogHttpError('Deezer asked to slow down', 'rate-limited', 429, 5000);
      if (code === 800 || code === 801) return null; // "no data": not found is an answer
      throw new CatalogHttpError(`Deezer refused: ${str(error['message'], 120) ?? 'unknown error'}`, 'http', null);
    }
    return body;
  }

  async list(path: string, signal?: AbortSignal): Promise<{ rows: Json[]; total: number | null }> {
    const body = await this.get(path, signal);
    return { rows: arr(body?.['data']), total: num(body?.['total']) };
  }

  /**
   * `limit` rows from `offset` of a Deezer list, asked for with its own `index`/`limit`, at most
   * `DEEZER_PAGE` at a time, until the rows are in or the list ends (its `total`, or a short page).
   */
  async pages(path: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ rows: Json[]; total: number | null }> {
    const rows: Json[] = [];
    let total: number | null = null;
    let index = offset;
    while (rows.length < limit) {
      const want = Math.min(DEEZER_PAGE, limit - rows.length);
      const page = await this.list(`${path}?index=${index}&limit=${want}`, signal);
      total = page.total ?? total;
      rows.push(...page.rows);
      index += page.rows.length;
      if (!page.rows.length || (total !== null ? index >= total : page.rows.length < want)) break;
    }
    return { rows, total };
  }

  async byIsrc(isrc: string, signal?: AbortSignal): Promise<CatalogTrack | null> {
    const body = await this.get(`/track/isrc:${encodeURIComponent(isrc)}`, signal);
    return body ? deezerTrack(body) : null;
  }

  async track(id: string, signal?: AbortSignal): Promise<CatalogTrack | null> {
    const body = await this.get(`/track/${encodeURIComponent(id)}`, signal);
    return body ? deezerTrack(body) : null;
  }

  async album(id: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ album: CatalogAlbum; tracks: CatalogTrack[]; total: number | null } | null> {
    const body = await this.get(`/album/${encodeURIComponent(id)}`, signal);
    const album = body ? deezerAlbum(body) : null;
    if (!album) return null;
    const page = await this.pages(`/album/${encodeURIComponent(id)}/tracks`, offset, limit, signal);
    const tracks = page.rows.map((r) => deezerTrack(r, album)).filter((t): t is CatalogTrack => t !== null);
    return { album, tracks, total: page.total ?? album.trackCount };
  }

  async artist(id: string, albumsOffset: number, albumsLimit: number, topLimit: number, signal?: AbortSignal): Promise<{ artist: CatalogArtist; topTracks: CatalogTrack[]; albums: CatalogAlbum[]; albumsTotal: number | null } | null> {
    const body = await this.get(`/artist/${encodeURIComponent(id)}`, signal);
    const artist = body ? deezerArtist(body) : null;
    if (!artist) return null;
    const [top, albums] = await Promise.all([this.list(`/artist/${encodeURIComponent(id)}/top?limit=${topLimit}`, signal), this.list(`/artist/${encodeURIComponent(id)}/albums?index=${albumsOffset}&limit=${albumsLimit}`, signal)]);
    return {
      artist,
      topTracks: top.rows.map((r) => deezerTrack(r)).filter((t): t is CatalogTrack => t !== null),
      albums: albums.rows.map((r) => deezerAlbum({ ...r, artist: r['artist'] ?? { name: artist.name } })).filter((a): a is CatalogAlbum => a !== null),
      albumsTotal: albums.total,
    };
  }

  async playlist(id: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ playlist: DeezerPlaylist; tracks: CatalogTrack[] } | null> {
    const body = await this.get(`/playlist/${encodeURIComponent(id)}`, signal);
    if (!body || num(body['id']) === null) return null;
    const page = await this.pages(`/playlist/${encodeURIComponent(id)}/tracks`, offset, limit, signal);
    const creator = isObject(body['creator']) ? body['creator'] : null;
    return {
      playlist: { id, title: str(body['title']) ?? 'Playlist', owner: str(creator?.['name']), artworkUrl: webUrl(body['picture_xl']) ?? dzCover(body['md5_image'], 'playlist'), total: posInt(body['nb_tracks']) ?? page.total, url: `https://www.deezer.com/playlist/${id}` },
      tracks: page.rows.map((r) => deezerTrack(r)).filter((t): t is CatalogTrack => t !== null),
    };
  }
}

const ENDPOINT: Record<CatalogSection, string> = { tracks: '/search/track', artists: '/search/artist', albums: '/search/album' };

export class DeezerProvider implements CatalogProvider {
  readonly id = 'deezer' as const;
  readonly sections: readonly CatalogSection[] = ['tracks', 'artists', 'albums'];
  readonly timeoutMs: number;

  constructor(readonly client: DeezerClient) {
    this.timeoutMs = client.timeoutMs * 2 + 500;
  }

  supports(query: CatalogQuery): boolean {
    return query.kind !== 'url';
  }

  async search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult> {
    const out = emptyResult();
    if (query.kind === 'isrc' && query.isrc) {
      if (!options.sections.includes('tracks')) return out;
      const track = await this.client.byIsrc(query.isrc, options.signal);
      out.tracks = track ? [track] : [];
      return out;
    }
    const sections = options.sections.filter((s) => this.sections.includes(s));
    const ask = async (section: CatalogSection): Promise<Json[]> => {
      const page = `&index=${options.offset}&limit=${options.limit}`;
      if (query.kind === 'advanced') {
        const strict = await this.client.list(`${ENDPOINT[section]}?q=${encodeURIComponent(deezerAdvanced(query))}${page}`, options.signal);
        if (strict.rows.length) return strict.rows;
      }
      return (await this.client.list(`${ENDPOINT[section]}?q=${encodeURIComponent(query.text)}${page}`, options.signal)).rows;
    };
    const settled = await Promise.allSettled(sections.map(ask));
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      const section = sections[i]!;
      out.full[section] = result.value.length >= options.limit;
      if (section === 'tracks') out.tracks = result.value.map((r) => deezerTrack(r)).filter((t): t is CatalogTrack => t !== null);
      if (section === 'albums') out.albums = result.value.map(deezerAlbum).filter((a): a is CatalogAlbum => a !== null);
      if (section === 'artists') out.artists = result.value.map(deezerArtist).filter((a): a is CatalogArtist => a !== null);
    });
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && settled.every((r) => r.status === 'rejected')) throw failed.reason;
    return out;
  }
}
