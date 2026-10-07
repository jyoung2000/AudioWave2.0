/**
 * YouTube and SoundCloud, searched through the yt-dlp the hub and the helper already run
 * (`ytsearchN:` / `scsearchN:`, flat, one JSON document). No account, no key.
 *
 * The domain does not start processes: the server passes a `ToolSearchRunner` that runs yt-dlp with
 * `toolSearchArgs` and hands back the parsed document. The arguments are built here, once, for both
 * servers: `--ignore-config` first, the search behind `--`, and the words cleaned of control
 * characters and capped, so nothing typed into a search box can become a flag.
 */
import type { CatalogQuery, CatalogSearchSection, CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { OFFICIAL_SOURCES, matchArtist } from '../merge.js';
import { cleanVideoTitle } from '../../titles.js';
import { arr, isObject, num, str, webUrl, type Json } from '../http.js';
import { emptyResult, type CatalogProvider, type ProviderResult, type ProviderSearchOptions } from '../provider.js';

export type ToolSearchPlatform = 'youtube' | 'soundcloud';

const PREFIX: Record<ToolSearchPlatform, string> = { youtube: 'ytsearch', soundcloud: 'scsearch' };
/** yt-dlp lists a search lazily, but a deep page still costs a long listing. */
export const TOOL_SEARCH_MAX = 100;

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
      label: null,
      sources: [source],
      rank: 0,
    };
  }
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
    genre: str(row['genre'], 100),
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

export class ToolSearchProvider implements CatalogProvider {
  readonly sections: readonly CatalogSearchSection[] = ['tracks'];

  constructor(
    readonly id: ToolSearchPlatform,
    private readonly run: ToolSearchRunner,
    readonly timeoutMs = 30_000,
  ) {}

  supports(query: CatalogQuery): boolean {
    return query.kind === 'text' || query.kind === 'advanced';
  }

  async search(query: CatalogQuery, options: ProviderSearchOptions): Promise<ProviderResult> {
    const out = emptyResult();
    if (!options.sections.includes('tracks') || options.offset >= TOOL_SEARCH_MAX) return out;
    const document = await this.run({ platform: this.id, args: toolSearchArgs(this.id, query.text, options.offset, options.limit), signal: options.signal });
    out.tracks = toolSearchTracks(this.id, document);
    out.full.tracks = out.tracks.length >= options.limit && options.offset + options.limit < TOOL_SEARCH_MAX;
    return out;
  }
}
