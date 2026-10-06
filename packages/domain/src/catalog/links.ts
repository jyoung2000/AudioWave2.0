/**
 * Links read by a tool (yt-dlp for YouTube, SoundCloud and Bandcamp; spotDL for Spotify), as
 * catalog rows. The servers already run these tools to resolve a pasted link — the hub's external
 * tool adapter, the helper's resolver — so they pass that reader in, and nothing here runs a process.
 */
import type { CatalogCollection, CatalogCollectionRef, CatalogPlatform, CatalogResolveResult, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { calendarDate, webUrl, yearOf } from './http.js';
import { normaliseIsrc, parseMusicLink, type MusicLink } from './query.js';
import { youtubeThumbnail } from './providers/ytdlp.js';

/** One song as a tool described it. Every field may be missing. */
export interface LinkTrack {
  url: string | null;
  title: string | null;
  artist: string | null;
  featured?: readonly string[] | undefined;
  album: string | null;
  durationSec: number | null;
  date: string | null;
  artworkUrl: string | null;
  trackNumber: number | null;
  discNumber?: number | null | undefined;
  isrc?: string | null | undefined;
  label?: string | null | undefined;
  explicit?: boolean | null | undefined;
  genre?: string | null | undefined;
  /** spotDL's YouTube Music match for a Spotify song, when it made one. */
  matchUrl?: string | null | undefined;
}

export type LinkRead =
  | { kind: 'track'; url: string; track: LinkTrack }
  | { kind: 'collection'; url: string; title: string; owner: string | null; artworkUrl: string | null; date: string | null; entries: LinkTrack[]; total: number | null; capped: boolean };

export type LinkReadErrorCode = 'tool-missing' | 'busy' | 'unavailable' | 'failed';

export class LinkReadError extends Error {
  constructor(
    message: string,
    readonly code: LinkReadErrorCode,
  ) {
    super(message);
    this.name = 'LinkReadError';
  }
}

export interface LinkReadOptions {
  signal?: AbortSignal | undefined;
  /** Ask spotDL for its YouTube Music match too (slower: it searches). Track links only. */
  match?: boolean | undefined;
  /**
   * Describe these positions of a list in full (1-based, in this order) rather than listing the whole
   * list flat: how a page of a SoundCloud set's bare ids gets its titles, in one run of the tool.
   */
  items?: readonly number[] | undefined;
}

/** Reads a link with the server's tools. Throws `LinkReadError` (or anything) when it cannot. */
export type LinkReader = (url: string, options: LinkReadOptions) => Promise<LinkRead>;

/** Platforms a `LinkReader` is asked about; the others have public APIs or none. */
export const TOOL_PLATFORMS: readonly CatalogPlatform[] = ['youtube', 'youtube-music', 'soundcloud', 'bandcamp', 'spotify'];

function slugTitle(url: string | null): string | null {
  if (!url) return null;
  try {
    const slug = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    return slug ? slug.replace(/[-_]+/g, ' ').replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()).slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** A described song as a catalog row on `platform`. Null when there is not even an address. */
export function trackFromLink(entry: LinkTrack, fallback: { platform: CatalogPlatform; owner?: string | null; album?: string | null }): CatalogTrack | null {
  const url = webUrl(entry.url);
  if (!url) return null;
  const link = parseMusicLink(url);
  const platform: CatalogPlatform = link?.platform ?? fallback.platform;
  const id = link?.id ?? url;
  const title = entry.title || slugTitle(url) || 'Untitled';
  const soundcloudUser = link?.platform === 'soundcloud' && link.id ? link.id.split('/')[0] : undefined;
  const artist = entry.artist || fallback.owner || soundcloudUser || '';
  const featured = entry.featured ?? [];
  const releaseDate = calendarDate(entry.date);
  const sources: CatalogSource[] = [{ platform, id: link?.id ?? null, url: link?.url ?? url, previewUrl: null, matchedBy: 'link' }];
  const match = webUrl(entry.matchUrl);
  if (match) {
    const m = parseMusicLink(match);
    sources.push({ platform: m?.platform === 'youtube' ? 'youtube-music' : (m?.platform ?? 'youtube-music'), id: m?.id ?? null, url: m?.platform === 'youtube' && m.id ? `https://music.youtube.com/watch?v=${encodeURIComponent(m.id)}` : (m?.url ?? match), previewUrl: null, matchedBy: 'spotdl' });
  }
  const isYoutube = platform === 'youtube' || platform === 'youtube-music';
  return {
    id: `${platform}:${id}`,
    title,
    artist: featured.length && artist ? `${artist} feat. ${featured.join(' & ')}` : artist,
    artists: artist ? [artist, ...featured] : [...featured],
    album: entry.album ?? fallback.album ?? null,
    albumArtist: null,
    durationMs: entry.durationSec !== null && entry.durationSec > 0 ? Math.round(entry.durationSec * 1000) : null,
    isrc: normaliseIsrc(entry.isrc ?? null),
    artworkUrl: webUrl(entry.artworkUrl) ?? (isYoutube && link?.id && link.kind === 'track' ? youtubeThumbnail(link.id) : null),
    releaseDate,
    year: yearOf(releaseDate),
    trackNumber: entry.trackNumber,
    discNumber: entry.discNumber ?? null,
    bpm: null,
    explicit: entry.explicit ?? null,
    genre: entry.genre ?? null,
    label: entry.label ?? null,
    sources,
    rank: 0,
  };
}

/**
 * Where a song's audio can be fetched from, best first: YouTube Music's recording of the song (the
 * one spotDL itself would pick), a YouTube upload, SoundCloud, Bandcamp, then a Spotify link — which
 * spotDL turns into that same YouTube Music recording. The stores (Apple Music, Deezer) and
 * MusicBrainz are never a download source: they sell or describe music, they do not hand it out.
 */
export const DOWNLOAD_SOURCE_ORDER: readonly CatalogPlatform[] = ['youtube-music', 'youtube', 'soundcloud', 'bandcamp', 'spotify'];

export function pickDownloadSource(sources: readonly CatalogSource[]): CatalogSource | null {
  for (const platform of DOWNLOAD_SOURCE_ORDER) {
    const found = sources.find((s) => s.platform === platform && webUrl(s.url));
    if (found) return found;
  }
  return null;
}

/** The first `n` pieces of artwork, in list order, for a mosaic. */
export function coversOf(tracks: readonly Pick<CatalogTrack, 'artworkUrl'>[], n = 4): string[] {
  const out: string[] = [];
  for (const t of tracks) {
    if (t.artworkUrl && !out.includes(t.artworkUrl)) out.push(t.artworkUrl);
    if (out.length >= n) break;
  }
  return out;
}

/** Every song of a list, fetched page after page (`collectAllPages`). */
export interface CollectedList {
  /** The first page's answer: what the list is (kind, ref, covers, reason). */
  first: CatalogResolveResult;
  tracks: CatalogTrack[];
  /** What the platform says the list holds, when it says. */
  total: number | null;
  /** True when the bound stopped the reading before the end: said, never a silent cut. */
  capped: boolean;
}

/**
 * Read a whole list in order through any `resolve`-shaped call (the engine's own, the hub's
 * `GET catalog/resolve`, the helper's): `offset` advances by what each page held until `hasMore`
 * is false, a page comes back empty, or `max` songs are in. Usable by every app, so the player,
 * the hub and the companion page through a long playlist the same way.
 */
export async function collectAllPages(page: (offset: number, limit: number) => Promise<CatalogResolveResult>, options: { max: number; pageSize: number; signal?: AbortSignal; onPage?: (result: CatalogResolveResult) => void }): Promise<CollectedList> {
  const first = await page(0, Math.min(options.pageSize, options.max));
  options.onPage?.(first);
  const tracks = [...(first.collection?.page.tracks ?? [])];
  let last = first.collection?.page ?? null;
  while (last && last.hasMore && tracks.length < options.max && !options.signal?.aborted) {
    const next = await page(tracks.length, Math.min(options.pageSize, options.max - tracks.length));
    options.onPage?.(next);
    const rows = next.collection?.page.tracks ?? [];
    if (!rows.length) break;
    tracks.push(...rows);
    last = next.collection?.page ?? null;
  }
  const total = first.collection?.page.total ?? null;
  const stopped = Boolean(last?.hasMore) && tracks.length >= options.max;
  return { first, tracks: tracks.slice(0, options.max), total, capped: stopped || Boolean(last?.capped) };
}

/** An ordered list as one page of it. `capped`: the bound (CATALOG_COLLECTION_CAP) left songs out for good. */
export function pageOf(tracks: readonly CatalogTrack[], offset: number, limit: number, total: number | null, capped: boolean): CatalogCollection['page'] {
  const slice = tracks.slice(offset, offset + limit);
  const known = total ?? tracks.length;
  return { tracks: slice, offset, limit, total: total ?? tracks.length, hasMore: offset + slice.length < Math.min(known, tracks.length), capped };
}

export function collectionRef(link: MusicLink, kind: 'album' | 'playlist', title: string, owner: string | null, url?: string): CatalogCollectionRef {
  return { platform: link.platform, kind, id: link.id ?? link.url, url: url ?? link.url, title: title.slice(0, 300), owner: owner?.slice(0, 300) ?? null };
}
