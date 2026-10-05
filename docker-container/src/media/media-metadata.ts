/**
 * What a link is, read from the tool that will download it — no API key involved.
 *
 * yt-dlp answers `--dump-single-json` with what the site itself publishes: for a YouTube video the
 * title, channel, duration, upload date and thumbnail; for SoundCloud the track, artist, genre,
 * release date and artwork; for a playlist or set (`--flat-playlist`) the list of entries. spotDL
 * answers `save` with Spotify's own track data — name, artists, album, date, cover, track and disc
 * number — for one song or for every song of an album or playlist.
 *
 * These functions only *map* that JSON; they never run anything, so the tests feed them recorded
 * answers (tests/fixtures/media-metadata). Everything that comes out is clipped to the contract's
 * lengths, and anything that does not look like what it claims (a date, an https URL) is dropped
 * rather than passed on.
 */
import type { DownloadTags } from '@now-playing/contracts';
import { cleanVideoTitle, splitFeatured } from '@now-playing/domain';

export interface ProbedTrack {
  kind: 'track';
  /** The page the tool says the track lives at. */
  url: string;
  tags: DownloadTags;
}

export interface ProbedEntry {
  url: string;
  /** What the listing says about the entry; a flat YouTube listing has a title, a SoundCloud set has nothing. */
  tags: DownloadTags | null;
  /** Why it cannot be taken, when the listing already says so (a private or deleted video, a nested list). */
  unavailable: string | null;
}

export interface ProbedPlaylist {
  kind: 'playlist';
  url: string;
  title: string | null;
  owner: string | null;
  artworkUrl: string | null;
  /** What the source says the list holds, which can be more than was listed. */
  listed: number | null;
  entries: ProbedEntry[];
}

export type MediaProbe = ProbedTrack | ProbedPlaylist;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function int(value: unknown, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

function https(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function durationMs(seconds: unknown): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** yt-dlp writes `YYYYMMDD`; spotDL writes `YYYY-MM-DD`, `YYYY-MM` or `YYYY`. Anything else is not a date. */
export function normaliseDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 999 && value < 10000) return String(value);
  if (typeof value !== 'string') return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value) ? value : null;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => text(v, 200)).filter((v): v is string => v !== null);
}

function emptyTags(title: string): DownloadTags {
  return { title, artist: null, featured: [], album: null, albumArtist: null, date: null, genre: null, trackNumber: null, discNumber: null, durationMs: null, artworkUrl: null, license: null };
}

/** " - Topic" channels are YouTube's auto-generated artist channels; "VEVO" is a label suffix. */
function channelArtist(channel: string | null): string | null {
  if (!channel) return null;
  return channel.replace(/\s+-\s+Topic$/, '').replace(/VEVO$/, '').trim() || null;
}

const normalise = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Title and artist for a video, which has a title and a channel and nothing else.
 *
 * `cleanVideoTitle` reads "Artist - Song (feat. X) [Official Video]". Two cases it cannot know about
 * are settled here, from the channel: a title it cannot split is by the channel ("Flickermood" by
 * "Forss"), and a split whose right-hand side names the channel is the other way round — "Big Buck
 * Bunny - Official Blender Foundation Short Film" on Blender's channel is a film called Big Buck
 * Bunny by Blender, not a song called "Official Blender Foundation Short Film".
 */
export function videoTitle(title: string, channel: string | null): { title: string; artist: string | null; featured: string[] } {
  const cleaned = cleanVideoTitle({ title, channel });
  const owner = channelArtist(channel);
  if (!cleaned.artist) return { title: cleaned.title || title, artist: owner, featured: cleaned.featured };
  if (owner && !cleaned.fromTopicChannel) {
    const ch = normalise(owner);
    if (ch && !normalise(cleaned.artist).includes(ch) && normalise(cleaned.title).includes(ch)) return { title: cleaned.artist, artist: owner, featured: cleaned.featured };
  }
  return { title: cleaned.title, artist: cleaned.artist, featured: cleaned.featured };
}

/** One yt-dlp info dictionary (a video, a SoundCloud track, a Bandcamp track) as tags. */
export function tagsFromYtDlp(info: Json): DownloadTags | null {
  const rawTitle = text(info['track'], 300) ?? text(info['title'], 300) ?? text(info['fulltitle'], 300);
  if (!rawTitle) return null;
  const artists = names(info['artists']);
  const declaredArtist = artists[0] ?? text(info['artist'], 300) ?? text(info['creator'], 300);
  let title: string;
  let artist: string | null;
  let featured: string[];
  if (declaredArtist && (text(info['track'], 300) || info['extractor_key'] !== 'Youtube')) {
    // The site said who made it (YouTube Music, SoundCloud, Bandcamp): believe it over the title.
    const split = splitFeatured(rawTitle);
    title = split.title || rawTitle;
    artist = declaredArtist;
    featured = [...new Set([...artists.slice(1), ...split.featured])];
  } else {
    ({ title, artist, featured } = videoTitle(rawTitle, text(info['channel'], 300) ?? text(info['uploader'], 300)));
  }
  const genre = text(info['genre'], 100) ?? names(info['genres'])[0] ?? null;
  return {
    title: title.slice(0, 300),
    artist: artist?.slice(0, 300) ?? null,
    featured: featured.filter((name) => name !== artist).slice(0, 20),
    album: text(info['album'], 300),
    albumArtist: text(info['album_artist'], 300) ?? names(info['album_artists'])[0] ?? null,
    date: normaliseDate(info['release_date']) ?? normaliseDate(info['upload_date']) ?? normaliseDate(info['release_year']),
    genre: genre?.slice(0, 100) ?? null,
    trackNumber: int(info['track_number'], 9999),
    discNumber: int(info['disc_number'], 999),
    durationMs: durationMs(info['duration']),
    artworkUrl: https(info['thumbnail']),
    license: text(info['license'], 200),
  };
}

const UNAVAILABLE_TITLES = /^\[(private|deleted|unavailable) video\]$/i;

/** `--dump-single-json`, with or without `--flat-playlist`, as a track or a playlist. */
export function fromYtDlp(json: unknown, requested: string): MediaProbe | null {
  if (!isObject(json)) return null;
  const url = https(json['webpage_url']) ?? https(json['original_url']) ?? requested;
  if (json['_type'] === 'playlist' || Array.isArray(json['entries'])) {
    const entries: ProbedEntry[] = [];
    for (const raw of Array.isArray(json['entries']) ? json['entries'] : []) {
      if (!isObject(raw)) continue;
      const entryUrl = https(raw['url']) ?? https(raw['webpage_url']);
      if (!entryUrl) continue;
      const nested = raw['_type'] === 'playlist' || (raw['ie_key'] === 'YoutubeTab' && raw['_type'] === 'url');
      const title = text(raw['title'], 300);
      const unavailable = nested ? 'It is a list of its own' : title && UNAVAILABLE_TITLES.test(title) ? 'The source lists it as unavailable' : null;
      const tags = title ? tagsFromYtDlp(raw) : null;
      if (tags && !tags.album) tags.album = text(raw['album'], 300);
      entries.push({ url: entryUrl, tags, unavailable });
    }
    const listed = typeof json['playlist_count'] === 'number' && Number.isInteger(json['playlist_count']) ? (json['playlist_count'] as number) : null;
    return {
      kind: 'playlist',
      url,
      title: text(json['title'], 300) ?? text(json['album'], 300),
      owner: text(json['album_artist'], 300) ?? channelArtist(text(json['channel'], 300) ?? text(json['uploader'], 300)),
      artworkUrl: https(json['thumbnail']) ?? thumbnailFrom(json['thumbnails']),
      listed,
      entries,
    };
  }
  const tags = tagsFromYtDlp(json);
  return tags ? { kind: 'track', url, tags } : null;
}

function thumbnailFrom(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const candidate = value[i];
    if (isObject(candidate)) {
      const url = https(candidate['url']);
      if (url) return url;
    }
  }
  return null;
}

/** One song of a `.spotdl` save file as tags. */
export function tagsFromSpotdl(song: Json): DownloadTags | null {
  const name = text(song['name'], 300);
  if (!name) return null;
  const artists = names(song['artists']);
  const artist = artists[0] ?? text(song['artist'], 300);
  const split = splitFeatured(name);
  const genre = names(song['genres']).find(Boolean) ?? null;
  return {
    ...emptyTags(split.title || name),
    artist,
    featured: [...new Set([...artists.slice(1), ...split.featured])].filter((n) => n !== artist).slice(0, 20),
    album: text(song['album_name'], 300),
    albumArtist: text(song['album_artist'], 300),
    date: normaliseDate(song['date']) ?? normaliseDate(song['year']),
    genre: genre?.slice(0, 100) ?? null,
    trackNumber: int(song['track_number'], 9999),
    discNumber: int(song['disc_number'], 999),
    durationMs: durationMs(song['duration']),
    artworkUrl: https(song['cover_url']),
  };
}

/** A `.spotdl` save file: one song for a track link, every song for an album or a playlist. */
export function fromSpotdl(json: unknown, requested: string): MediaProbe | null {
  if (!Array.isArray(json)) return null;
  const songs = json.filter(isObject);
  const path = (() => {
    try {
      return new URL(requested).pathname;
    } catch {
      return '';
    }
  })();
  if (/^\/(?:intl-[a-z-]+\/)?track\//i.test(path)) {
    const first = songs[0];
    const tags = first ? tagsFromSpotdl(first) : null;
    return tags ? { kind: 'track', url: https(first!['url']) ?? requested, tags } : null;
  }
  const ordered = [...songs].sort((a, b) => order(a) - order(b));
  const first = ordered[0];
  return {
    kind: 'playlist',
    url: requested,
    title: first ? (text(first['list_name'], 300) ?? text(first['album_name'], 300)) : null,
    owner: first ? (text(first['album_artist'], 300) ?? text(first['artist'], 300)) : null,
    artworkUrl: first ? https(first['cover_url']) : null,
    listed: first ? (int(first['list_length'], 100_000) ?? int(first['tracks_count'], 100_000) ?? ordered.length) : 0,
    entries: ordered.map((song) => ({ url: https(song['url']) ?? '', tags: tagsFromSpotdl(song), unavailable: null })).filter((e) => e.url),
  };
}

function order(song: Json): number {
  const position = int(song['list_position'], 100_000);
  if (position) return position;
  return (int(song['disc_number'], 999) ?? 1) * 10_000 + (int(song['track_number'], 9999) ?? 9999);
}

/**
 * Whether a link names a list rather than a track, from its shape alone. Used to send a list to
 * `POST /downloads/batch` before anything runs; the tool's own answer settles it there.
 */
export function isCollectionUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (/(^|\.)youtube\.com$/.test(host)) return path === '/playlist' || (url.searchParams.has('list') && !url.searchParams.has('v') && !path.startsWith('/watch'));
  if (/(^|\.)soundcloud\.com$/.test(host)) return /\/sets\//.test(path);
  if (host === 'open.spotify.com') return /^\/(?:intl-[a-z-]+\/)?(album|playlist|artist)\//i.test(path);
  if (/(^|\.)bandcamp\.com$/.test(host)) return /^\/album\//.test(path);
  return false;
}

/** Fill the gaps in what was already known from what the tool reported; what was known stays. */
export function mergeTags(known: DownloadTags | null | undefined, reported: DownloadTags | null): DownloadTags | null {
  if (!known) return reported;
  if (!reported) return known;
  const merged: DownloadTags = { ...reported };
  for (const key of Object.keys(known) as Array<keyof DownloadTags>) {
    const value = known[key];
    if (key === 'featured') {
      if (known.featured.length) merged.featured = known.featured;
    } else if (value !== null && value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** "city-ports" → "City Ports": what a SoundCloud set entry is called before anything has run. */
export function titleFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const slug = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    if (!slug) return null;
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase())
      .slice(0, 300);
  } catch {
    return null;
  }
}
