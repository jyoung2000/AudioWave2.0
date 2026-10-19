/**
 * YouTube and SoundCloud, searched through the yt-dlp the hub and the helper already run
 * (`ytsearchN:` / `scsearchN:`, flat, one JSON document). No account, no key.
 *
 * The domain does not start processes: the server passes a `ToolSearchRunner` that runs yt-dlp with
 * `toolSearchArgs` and hands back the parsed document. The arguments are built here, once, for both
 * servers: `--ignore-config` first, the search behind `--`, and the words cleaned of control
 * characters and capped, so nothing typed into a search box can become a flag.
 */
import type { CatalogAlbum, CatalogQuery, CatalogSearchSection, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { OFFICIAL_SOURCES, matchArtist } from '../merge.js';
import { cleanVideoTitle } from '../../titles.js';
import { arr, isObject, num, str, webUrl, type Json } from '../http.js';
import { emptyResult, type CatalogProvider, type ProviderResult, type ProviderSearchOptions } from '../provider.js';

export type ToolSearchPlatform = 'youtube' | 'soundcloud';

const PREFIX: Record<ToolSearchPlatform, string> = { youtube: 'ytsearch', soundcloud: 'scsearch' };
/**
 * How many of a search's uploaders are asked for their albums. SoundCloud has no album search of its
 * own (`/search/albums` is not a page yt-dlp can read, and `scsearch` lists songs), so an artist's
 * own album tab is the only keyless way there: the uploaders the songs came from, best first, each
 * costing one listing of about ten seconds (measured 2026-10-18).
 */
export const TOOL_ALBUM_UPLOADERS = 2;
/** yt-dlp lists a search lazily, but a deep page still costs a long listing. */
export const TOOL_SEARCH_MAX = 100;
/** The length SoundCloud gives a snipped (Go+) song: its 30-second preview, to the millisecond. */
const SOUNDCLOUD_PREVIEW_SECONDS = 30;

/** The words, safe to hand to yt-dlp: printable, single-spaced, at most 200 characters. */
export function toolSearchTerm(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const printable = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return printable.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The yt-dlp command line for one page of a search. The search string is last, behind `--`. */
export function toolSearchArgs(platform: ToolSearchPlatform, text: string, offset: number, limit: number): string[] {
  const term = toolSearchTerm(text);
  if (!term) throw new Error('Nothing to search for');
  const end = Math.min(Math.max(offset, 0) + Math.max(limit, 1), TOOL_SEARCH_MAX);
  const start = Math.min(Math.max(offset, 0) + 1, end);
  return ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-warnings', '--flat-playlist', '--dump-single-json', '--playlist-start', String(start), '--playlist-end', String(end), '--', `${PREFIX[platform]}${end}:${term}`];
}

/**
 * The yt-dlp command line for one SoundCloud profile's album tab. `user` is a permalink — the first
 * path segment of a soundcloud.com address — and is checked here, so nothing read out of a search
 * document can become a flag or another host.
 */
export function soundcloudAlbumsArgs(user: string, limit: number): string[] {
  if (!/^[a-z0-9][a-z0-9_-]{1,70}$/i.test(user)) throw new Error('That is not a SoundCloud profile name');
  const end = Math.min(Math.max(limit, 1), TOOL_SEARCH_MAX);
  return ['--ignore-config', '--no-colors', '--no-cache-dir', '--no-warnings', '--flat-playlist', '--dump-single-json', '--playlist-start', '1', '--playlist-end', String(end), '--', `https://soundcloud.com/${user.toLowerCase()}/albums`];
}

export interface ToolSearchInput {
  platform: ToolSearchPlatform;
  args: string[];
  signal: AbortSignal;
}

/** Runs yt-dlp with `args` and resolves to its parsed stdout. Supplied by the server. */
export type ToolSearchRunner = (input: ToolSearchInput) => Promise<unknown>;

/** A YouTube video's own thumbnail, which exists for every id without asking. */
export function youtubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

function bestThumbnail(row: Json): string | null {
  const direct = webUrl(row['thumbnail']);
  if (direct) return direct;
  const list = arr(row['thumbnails']).filter((t) => webUrl(t['url']));
  const best = [...list].sort((a, b) => (num(b['width']) ?? 0) - (num(a['width']) ?? 0))[0];
  return best ? webUrl(best['url']) : null;
}

/** "Daft Punk - Topic" is the channel YouTube Music files a song under; "DaftPunkVEVO" is a label's. */
function channelArtist(channel: string | null): string | null {
  if (!channel) return null;
  return channel.replace(/\s+-\s+Topic$/i, '').replace(/VEVO$/i, '').trim() || null;
}

/** "city-ports" → "City Ports": what a SoundCloud entry listed by address alone is called. */
function fromSlug(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase())
    .slice(0, 300);
}

export function toolSearchTrack(platform: ToolSearchPlatform, row: Json): CatalogTrack | null {
  const url = webUrl(row['webpage_url']) ?? webUrl(row['url']);
  if (!url) return null;
  const duration = num(row['duration']);
  const durationMs = duration !== null && duration > 0 ? Math.round(duration * 1000) : null;
  if (platform === 'youtube') {
    const id = str(row['id'], 40) ?? new URL(url).searchParams.get('v');
    const rawTitle = str(row['title']);
    if (!id || !rawTitle) return null;
    const channel = str(row['channel']) ?? str(row['uploader']);
    const cleaned = cleanVideoTitle({ title: rawTitle, channel });
    const artist = cleaned.artist ?? channelArtist(channel);
    if (!artist) return null;
    const source: CatalogSource = { platform: cleaned.fromTopicChannel ? 'youtube-music' : 'youtube', id, url: cleaned.fromTopicChannel ? `https://music.youtube.com/watch?v=${encodeURIComponent(id)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, previewUrl: null, matchedBy: 'search' };
    // An official upload: YouTube Music's Topic recording, a VEVO channel, the artist's own channel, or a
    // title that says "Official". Only these join a store's row when yt-dlp gave no duration.
    const own = channelArtist(channel);
    if (cleaned.fromTopicChannel || /vevo$/i.test(channel ?? '') || (own && matchArtist(own) === matchArtist(artist)) || /\bofficial\b/i.test(rawTitle)) OFFICIAL_SOURCES.add(source);
    return {
      id: `youtube:${id}`,
      title: cleaned.title,
      artist: cleaned.featured.length ? `${artist} feat. ${cleaned.featured.join(' & ')}` : artist,
      artists: [artist, ...cleaned.featured],
      album: str(row['album']),
      albumArtist: null,
      durationMs,
      isrc: null,
      artworkUrl: bestThumbnail(row) ?? youtubeThumbnail(id),
      releaseDate: null,
      year: null,
      trackNumber: null,
      discNumber: null,
      bpm: null,
      explicit: null,
      genre: null,
      artistId: null,
      albumId: null,
      tags: [],
      label: null,
      sources: [source],
      rank: 0,
    };
  }
  // A SoundCloud Go+ song is "snipped" for everyone else: the search lists it at exactly 30 s (its
  // own length has milliseconds, 246.381), and all it will play or download is a 30-second preview
  // (`*_preview` formats only; measured 2026-10-10 on Daft Punk's own "Get Lucky"). It is not a
  // home for the song, so it is not a row.
  if (duration === SOUNDCLOUD_PREVIEW_SECONDS) return null;
  let path: string[];
  try {
    path = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (path.length < 2 || path[1] === 'sets') return null;
  const title = str(row['title']) ?? fromSlug(path[1]!);
  const artist = str(row['uploader']) ?? str(row['artist']) ?? fromSlug(path[0]!);
  const id = str(row['id'], 60) ?? `${path[0]}/${path[1]}`;
  return {
    id: `soundcloud:${id}`,
    title,
    artist,
    artists: [artist],
    album: str(row['album']),
    albumArtist: null,
    durationMs,
    isrc: null,
    artworkUrl: bestThumbnail(row),
    releaseDate: null,
    year: null,
    trackNumber: null,
    discNumber: null,
    bpm: null,
    explicit: null,
    // A search entry names its genres as a list (`genres: ["Electronic"]`); a track page as `genre`.
    genre: str(row['genre'], 100) ?? str(Array.isArray(row['genres']) ? (row['genres'] as unknown[])[0] : null, 100),
    artistId: null,
    albumId: null,
    // SoundCloud publishes the uploader's own words for the track. They are the platform's stated
    // tags, unlike YouTube's, which are search keywords the uploader chose to be found by.
    tags: Array.isArray(row['tags'])
      ? [...new Set((row['tags'] as unknown[]).map((t) => str(t, 80)).filter((t): t is string => !!t))].slice(0, 30)
      : [],
    label: null,
    sources: [{ platform: 'soundcloud', id, url: url.split('?')[0]!, previewUrl: null, matchedBy: 'search' }],
    rank: 0,
  };
}

/** A search document from yt-dlp as tracks. Anything that is not one song (a channel, a set) is left out. */
export function toolSearchTracks(platform: ToolSearchPlatform, document: unknown): CatalogTrack[] {
  if (!isObject(document)) return [];
  return arr(document['entries'])
    .filter((e) => e['_type'] !== 'playlist' && !(typeof e['ie_key'] === 'string' && /Tab|Playlist|User/i.test(e['ie_key'])))
    .map((e) => toolSearchTrack(platform, e))
    .filter((t): t is CatalogTrack => t !== null);
}

/**
 * The uploaders a SoundCloud song search listed, best first and each once: their profile permalinks,
 * which is what an album tab is addressed by. A song whose uploader is only named (no address) is
 * skipped rather than guessed at — a display name is not a permalink.
 */
export function soundcloudUploaders(document: unknown, max = TOOL_ALBUM_UPLOADERS): string[] {
  if (!isObject(document)) return [];
  const out: string[] = [];
  for (const row of arr(document['entries'])) {
    const profile = webUrl(row['uploader_url']) ?? webUrl(row['channel_url']);
    const page = webUrl(row['webpage_url']);
    let user: string | null = null;
    for (const candidate of [profile, page]) {
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        if (!/(^|\.)soundcloud\.com$/.test(url.hostname)) continue;
        const first = url.pathname.split('/').filter(Boolean)[0];
        if (first && /^[a-z0-9][a-z0-9_-]{1,70}$/i.test(first)) {
          user = first.toLowerCase();
          break;
        }
      } catch {
        continue;
      }
    }
    if (user && !out.includes(user)) out.push(user);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * One SoundCloud profile's album tab as catalog albums. The tab lists each album by address and
 * title only, so `trackCount`, artwork and date stay null rather than invented: the row opens, and
 * resolving its address is what reads its songs. `owner` is the profile the tab belongs to.
 */
export function soundcloudAlbums(document: unknown, owner: string | null): CatalogAlbum[] {
  if (!isObject(document)) return [];
  const out: CatalogAlbum[] = [];
  for (const row of arr(document['entries'])) {
    const url = webUrl(row['webpage_url']) ?? webUrl(row['url']);
    if (!url) continue;
    let path: string[];
    try {
      const parsed = new URL(url);
      if (!/(^|\.)soundcloud\.com$/.test(parsed.hostname)) continue;
      path = parsed.pathname.split('/').filter(Boolean);
    } catch {
      continue;
    }
    // Only a set is an album here: /<user>/sets/<slug>. A song or a tab is not.
    if (path.length < 3 || path[1] !== 'sets') continue;
    const id = `${path[0]}/sets/${path[2]}`;
    const title = str(row['title']) ?? fromSlug(path[2]!);
    const artist = str(row['uploader']) ?? str(row['artist']) ?? owner ?? fromSlug(path[0]!);
    if (out.some((a) => a.id === `soundcloud:${id}`)) continue;
    out.push({
      id: `soundcloud:${id}`,
      title,
      artist,
      artworkUrl: bestThumbnail(row),
      releaseDate: null,
      year: null,
      trackCount: null,
      label: null,
      genre: null,
      explicit: null,
      upc: null,
      sources: [{ platform: 'soundcloud', id, url: `https://soundcloud.com/${id}`, previewUrl: null, matchedBy: 'search' }],
      rank: 0,
    });
  }
  return out;
}

export class ToolSearchProvider implements CatalogProvider {
  readonly sections: readonly CatalogSearchSection[];

  constructor(
    readonly id: ToolSearchPlatform,
    private readonly run: ToolSearchRunner,
    readonly timeoutMs = 30_000,
  ) {
    // SoundCloud alone also answers albums: an uploader's own album tab (DEC-039 follow-up).
    this.sections = id === 'soundcloud' ? ['tracks', 'albums'] : ['tracks'];
  }

  supports(query: CatalogQuery): boolean {
    return query.kind === 'text' || query.kind === 'advanced';
  }

  async search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult> {
    const out = emptyResult();
    const wantsTracks = options.sections.includes('tracks');
    const wantsAlbums = this.id === 'soundcloud' && options.sections.includes('albums');
    if ((!wantsTracks && !wantsAlbums) || options.offset >= TOOL_SEARCH_MAX) return out;
    const document = await this.run({ platform: this.id, args: toolSearchArgs(this.id, query.text, options.offset, options.limit), signal: options.signal });
    if (wantsTracks) {
      out.tracks = toolSearchTracks(this.id, document);
      // Whether there is more is what yt-dlp listed, not what was kept: a page whose channels, sets or
      // previews were left out is still a full page.
      const listed = isObject(document) ? arr(document['entries']).length : 0;
      out.full.tracks = listed >= options.limit && options.offset + options.limit < TOOL_SEARCH_MAX;
    }
    // SoundCloud has no album search: the albums are the uploaders' own album tabs. Only the first
    // page asks for them — a deeper page of songs is not a deeper page of albums.
    if (wantsAlbums && options.offset === 0) {
      for (const user of soundcloudUploaders(document)) {
        if (options.signal.aborted) break;
        try {
          const tab = await this.run({ platform: this.id, args: soundcloudAlbumsArgs(user, options.limit), signal: options.signal });
          for (const album of soundcloudAlbums(tab, user)) if (!out.albums.some((a) => a.id === album.id)) out.albums.push(album);
        } catch {
          // One profile with no album tab (or a listing that failed) is not the search failing.
          continue;
        }
      }
      out.full.albums = false;
    }
    return out;
  }
}
