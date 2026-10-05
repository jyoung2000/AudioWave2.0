/**
 * What a downloaded file's tags should say, worked out once from what the site said about it.
 *
 * yt-dlp describes a link as a JSON object (`--dump-single-json`). For a YouTube upload the title is
 * the video's title — "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)" — and
 * written into a file as-is it makes a library full of brackets. So the title goes through
 * `cleanVideoTitle` (the same rules the hub's enrichment matcher uses), the channel stands in for the
 * artist when the title names none, and the date is a whole date rather than a run of digits.
 *
 * **Featured artists** go into the artist tag in the conventional form, "Artist feat. Guest" (two
 * or more: "Artist feat. Guest & Other"), and the album artist tag carries the main artist alone.
 * That is what every player that knows nothing about features still shows sensibly, and what
 * `splitFeatured` reads back.
 *
 * Shared by the local helper (which writes these through yt-dlp's own `meta_*` fields) and, when it
 * adopts it, the hub. Nothing here touches a file or a process.
 */
import { cleanVideoTitle, splitFeatured } from './titles.js';

/** The fields of a yt-dlp info object this reads. Everything is optional: sites say what they say. */
export interface MediaInfo {
  title?: unknown;
  track?: unknown;
  artist?: unknown;
  artists?: unknown;
  creator?: unknown;
  album?: unknown;
  album_artist?: unknown;
  uploader?: unknown;
  channel?: unknown;
  genre?: unknown;
  genres?: unknown;
  release_date?: unknown;
  upload_date?: unknown;
  release_year?: unknown;
  track_number?: unknown;
  extractor_key?: unknown;
  webpage_url?: unknown;
}

export interface CleanTags {
  title: string;
  /** The main artist, or null when nothing names one. */
  artist: string | null;
  featured: string[];
  album: string | null;
  genre: string | null;
  /** `YYYY-MM-DD` (or `YYYY-MM`) when the source gives one. */
  date: string | null;
  year: number | null;
  trackNumber: number | null;
}

function text(value: unknown, max = 300): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function firstText(value: unknown): string | null {
  return Array.isArray(value) ? (value.map((v) => text(v)).find(Boolean) ?? null) : text(value);
}

/**
 * A calendar date in the form tags and the contracts use: `YYYY-MM-DD`, or `YYYY-MM` when only the
 * month is known. Reads `20091025`, `2009-10-25`, `2009/10/25`, `2009-10-25T00:00:00Z` and `2009-10`.
 * A bare year is not a date (that is `year`'s job), and an impossible month or day is nothing.
 */
export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = /^(\d{4})(?:[-/.]?(\d{2})(?:[-/.]?(\d{2}))?)?(?:[T ].*)?$/.exec(s);
  if (!m || !m[2]) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1000 || year > 3000 || month < 1 || month > 12) return null;
  if (!m[3]) return `${m[1]}-${m[2]}`;
  const day = Number(m[3]);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * The release date a file's tags give, as `isoDate` spells it: the date tag first (what Airwave's
 * downloads write), then the release date, then the original release date. music-metadata names
 * them `date`, `releasedate` and `originaldate`.
 */
export function releaseDateOf(common: { date?: unknown; releasedate?: unknown; originaldate?: unknown }, native?: Record<string, ReadonlyArray<{ id: string; value: unknown }>>): string | null {
  return isoDate(common.date) ?? isoDate(common.releasedate) ?? isoDate(common.originaldate) ?? (native ? id3v23Date(native) : null);
}

/**
 * ID3v2.3 has no date frame, only a year (`TYER`) and a day and month (`TDAT`, "DDMM") — which is
 * how FFmpeg writes a whole date into an MP3 when yt-dlp asks for ID3v2.3, as it does. music-metadata
 * keeps only the year in `common`, so the date is put back together from the native frames.
 * (ID3v2.2 spells them `TYE` and `TDA`.)
 */
export function id3v23Date(native: Record<string, ReadonlyArray<{ id: string; value: unknown }>>): string | null {
  for (const [yearId, dayId, tags] of [
    ['TYER', 'TDAT', native['ID3v2.3']],
    ['TYE', 'TDA', native['ID3v2.2']],
  ] as const) {
    if (!tags) continue;
    const year = tags.find((t) => t.id === yearId)?.value;
    const day = tags.find((t) => t.id === dayId)?.value;
    const y = typeof year === 'string' || typeof year === 'number' ? String(year).trim() : '';
    const dm = typeof day === 'string' ? day.trim() : '';
    if (!/^\d{4}$/.test(y) || !/^\d{4}$/.test(dm)) continue;
    const date = isoDate(`${y}-${dm.slice(2, 4)}-${dm.slice(0, 2)}`);
    if (date) return date;
  }
  return null;
}

function isYouTube(info: MediaInfo): boolean {
  if (typeof info.extractor_key === 'string' && /^youtube/i.test(info.extractor_key)) return true;
  try {
    return typeof info.webpage_url === 'string' && /(^|\.)(youtube\.com|youtu\.be)$/i.test(new URL(info.webpage_url).hostname);
  } catch {
    return false;
  }
}

function dedupe(names: string[], except: string | null): string[] {
  const seen = new Set<string>(except ? [except.toLowerCase()] : []);
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Clean tags from a yt-dlp info object (one video or track, not a playlist).
 *
 * A source that names the track itself (`track`: SoundCloud, YouTube Music's auto-generated uploads,
 * Bandcamp) is believed, with the features in its title split off. A YouTube upload without one has
 * its title cleaned; the channel is the artist when the title does not name one.
 */
export function cleanTags(info: MediaInfo): CleanTags {
  const rawTitle = text(info.title) ?? 'Untitled';
  const channel = text(info.channel) ?? text(info.uploader);
  const artists = Array.isArray(info.artists) ? info.artists.map((a) => text(a)).filter((a): a is string => Boolean(a)) : [];
  const named = text(info.track);
  let title: string;
  let artist: string | null;
  let featured: string[];
  if (named) {
    const split = splitFeatured(named);
    title = split.title || named;
    artist = artists[0] ?? text(info.artist) ?? text(info.creator) ?? channel;
    featured = [...artists.slice(1), ...split.featured];
  } else if (isYouTube(info)) {
    const clean = cleanVideoTitle({ title: rawTitle, channel });
    title = clean.title || rawTitle;
    artist = clean.artist ?? (clean.fromTopicChannel ? null : channel);
    featured = clean.featured;
  } else {
    const split = splitFeatured(rawTitle);
    title = split.title || rawTitle;
    artist = artists[0] ?? text(info.artist) ?? text(info.creator) ?? channel;
    featured = split.featured;
  }
  const date = isoDate(info.release_date) ?? isoDate(info.upload_date);
  const releaseYear = typeof info.release_year === 'number' && Number.isInteger(info.release_year) ? info.release_year : null;
  const year = date ? Number(date.slice(0, 4)) : releaseYear;
  const trackNumber = typeof info.track_number === 'number' && Number.isInteger(info.track_number) && info.track_number > 0 ? info.track_number : null;
  return {
    title,
    artist,
    featured: dedupe(featured, artist).slice(0, 8),
    album: text(info.album),
    genre: text(info.genre, 60) ?? firstText(info.genres),
    date,
    year: year !== null && year >= 1000 && year <= 3000 ? year : null,
    trackNumber,
  };
}

/** "Artist feat. Guest", "Artist feat. Guest & Other" — the artist tag's conventional spelling. */
export function artistTag(artist: string | null, featured: readonly string[]): string | null {
  if (!artist) return featured.length ? featured.join(' & ') : null;
  return featured.length ? `${artist} feat. ${featured.join(' & ')}` : artist;
}

/**
 * The tags as yt-dlp's metadata post-processor reads overrides: an info field `meta_<tag>` is written
 * to the file's `<tag>`, ahead of anything yt-dlp would have picked. Set on the info object (never
 * passed on a command line), so no text from a site is ever read as a flag or a template.
 */
export function ytDlpMetaFields(tags: CleanTags): Record<string, string> {
  const out: Record<string, string> = { meta_title: tags.title };
  const artist = artistTag(tags.artist, tags.featured);
  if (artist) out['meta_artist'] = artist;
  if (tags.artist) out['meta_album_artist'] = tags.artist;
  if (tags.album) out['meta_album'] = tags.album;
  // Empty rather than absent: yt-dlp otherwise falls back to the site's category ("Film &
  // Animation", "People & Blogs"), which is not a genre. An empty value writes no genre tag.
  out['meta_genre'] = tags.genre ?? '';
  if (tags.date) out['meta_date'] = tags.date;
  else if (tags.year) out['meta_date'] = String(tags.year);
  return out;
}
