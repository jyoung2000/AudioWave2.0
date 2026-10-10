/**
 * The playlist folder's file format (DEC-041), pure: an `.m3u8` a person can read and any player can
 * open, and the `.airwave.json` sidecar beside it.
 *
 *     #EXTM3U
 *     #PLAYLIST:Road Trip
 *     #EXTINF:215,Daft Punk - Digital Love
 *     ../library/music/Daft Punk/Discovery/03 Digital Love.flac
 *     #EXTINF:200,Röyksopp - Eple
 *     https://www.deezer.com/track/3135556
 *
 * The M3U is authoritative for which songs are in a list and in what order. The sidecar carries what
 * M3U cannot (ids, dates, the description, the cover mosaic, each entry's catalog id, ISRC, artists,
 * album, platforms and added date) and is matched back to the M3U by location, so a list reordered or
 * trimmed in another player keeps the metadata of the songs it still holds.
 */
import { createHash } from 'node:crypto';
import { PLAYLIST_FOLDER_ENTRY_CAP, PLAYLIST_NAME_MAX, PLAYLIST_SIDECAR_FORMAT, type CatalogPlatform, type CatalogTrack, type PlaylistSidecar, type PlaylistSidecarEntry } from '@now-playing/contracts';
import { pickDownloadSource } from '../catalog/links.js';
import { sanitizeFilename } from '../security.js';

/** One song as an M3U line pair holds it. */
export interface M3uItem {
  /** The location line exactly as written (a relative path, a URL, or — in a hand-made list — anything). */
  location: string;
  durationSec: number | null;
  /** The `#EXTINF` text after the comma: usually "Artist - Title". */
  display: string | null;
}

export interface ParsedM3u {
  /** `#PLAYLIST:` when the file has one. */
  name: string | null;
  items: M3uItem[];
  /** True when the list held more than the cap and the rest was not read. */
  capped: boolean;
}

/** Line breaks and other control characters cannot be allowed into a line: they would start a new one. */
export function oneLine(text: string): string {
  // \s also takes U+2028 and U+2029, which JavaScript and some players read as line breaks.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  return text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isUrlLocation(location: string): boolean {
  return /^https?:\/\//i.test(location);
}

/** A drive, a UNC share, a rooted path or a file: URL — never written by Airwave, and never followed. */
export function isAbsoluteLocation(location: string): boolean {
  return /^([a-zA-Z]:|[\\/]|file:)/i.test(location);
}

/** Read an M3U or M3U8 (a BOM, CRLF and extra blank lines are fine). Every non-comment line is an item. */
export function parsePlaylistM3u(text: string, cap = PLAYLIST_FOLDER_ENTRY_CAP): ParsedM3u {
  // A byte-order mark (U+FEFF) at the start is not part of the first line.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  let name: string | null = null;
  const items: M3uItem[] = [];
  let pending: { durationSec: number | null; display: string | null } | null = null;
  let capped = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#PLAYLIST:/i.test(line)) name = oneLine(line.slice('#PLAYLIST:'.length)) || null;
      else if (/^#EXTINF:/i.test(line)) {
        const m = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)?[^,]*,?(.*)$/i.exec(line);
        const secs = m?.[1] !== undefined ? Number(m[1]) : NaN;
        pending = { durationSec: Number.isFinite(secs) && secs >= 0 ? Math.round(secs) : null, display: oneLine(m?.[2] ?? '') || null };
      }
      continue;
    }
    if (items.length >= cap) {
      capped = true;
      break;
    }
    items.push({ location: line, durationSec: pending?.durationSec ?? null, display: pending?.display ?? null });
    pending = null;
  }
  return { name, items, capped };
}

/** Write an M3U8: `#EXTM3U`, `#PLAYLIST:<name>`, then `#EXTINF:<secs>,<artist> - <title>` and the location per song. */
export function serializePlaylistM3u(name: string, items: ReadonlyArray<{ location: string; durationSec: number | null; artist: string; title: string }>): string {
  const out = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`];
  for (const item of items) {
    const artist = oneLine(item.artist);
    const title = oneLine(item.title);
    out.push(`#EXTINF:${item.durationSec ?? -1},${artist && title ? `${artist} - ${title}` : artist || title}`);
    out.push(oneLine(item.location));
  }
  return out.join('\n') + '\n';
}

/** "Artist - Title" back into its parts; a display without " - " is a title alone. */
export function splitDisplay(display: string | null, location: string): { artist: string; title: string } {
  if (display) {
    const at = display.indexOf(' - ');
    if (at > 0) return { artist: display.slice(0, at).trim(), title: display.slice(at + 3).trim() || display };
    return { artist: '', title: display };
  }
  // No #EXTINF: the file name (or the URL's last part) is the best title there is.
  const last = location.split(/[\\/]/).filter(Boolean).pop() ?? location;
  let title = last;
  try {
    title = decodeURIComponent(last);
  } catch {
    // keep it as written
  }
  return { artist: '', title: title.replace(/\.[A-Za-z0-9]{2,5}$/, '').slice(0, 300) || location.slice(0, 300) };
}

/** The file name a playlist name becomes (without its extension): sanitised for Windows and Linux alike. */
export function playlistFileBase(name: string): string {
  return sanitizeFilename(oneLine(name), { maxLength: PLAYLIST_NAME_MAX, fallback: 'Playlist' });
}

/** A hand-made list's id: stable for its file name. */
export function handMadeId(fileName: string): string {
  return `m-${createHash('sha256').update(fileName.toLowerCase()).digest('hex').slice(0, 24)}`;
}

/** A hand-made entry's id: its place and what it points at. */
export function handMadeEntryId(index: number, location: string): string {
  return `e${index}-${createHash('sha256').update(location).digest('hex').slice(0, 10)}`;
}

/** Where a song from search plays from when it is not in the library: its best fetchable source, else its first. */
export function bestSourceUrl(track: Pick<CatalogTrack, 'sources'>): string | null {
  return pickDownloadSource(track.sources)?.url ?? track.sources[0]?.url ?? null;
}

/** A sidecar entry for a song from search. */
export function sidecarEntryFor(track: CatalogTrack, location: string | null, id: string, addedAt: string, addedBy: string | null): PlaylistSidecarEntry {
  const platforms = [...new Set(track.sources.map((s) => s.platform))] as CatalogPlatform[];
  return {
    id,
    location,
    title: track.title.slice(0, 300),
    artist: track.artist.slice(0, 300),
    artists: track.artists.slice(0, 20),
    album: track.album,
    durationSec: track.durationMs !== null ? Math.round(track.durationMs / 1000) : null,
    catalogId: track.id || null,
    isrc: track.isrc,
    artworkUrl: track.artworkUrl,
    platforms,
    sources: track.sources.slice(0, 20),
    addedAt,
    addedBy,
  };
}

/**
 * The sidecar matched back to its M3U: each M3U item takes the first unused sidecar entry with the
 * same location; an item without one (added in another player) is described from its #EXTINF.
 */
export function reconcile(parsed: ParsedM3u, sidecar: PlaylistSidecar | null): PlaylistSidecarEntry[] {
  const pool = new Map<string, PlaylistSidecarEntry[]>();
  for (const entry of sidecar?.entries ?? []) {
    const key = entry.location ?? '';
    pool.set(key, [...(pool.get(key) ?? []), entry]);
  }
  const used = new Set<string>();
  return parsed.items.map((item, index) => {
    const candidates = pool.get(item.location) ?? [];
    const match = candidates.find((c) => !used.has(c.id));
    if (match) {
      used.add(match.id);
      return { ...match, location: item.location };
    }
    let id = handMadeEntryId(index, item.location);
    while (used.has(id)) id = `${id}x`;
    used.add(id);
    const { artist, title } = splitDisplay(item.display, item.location);
    return { id, location: item.location, title, artist, artists: artist ? [artist] : [], album: null, durationSec: item.durationSec, catalogId: null, isrc: null, artworkUrl: null, platforms: [], sources: [], addedAt: null, addedBy: null };
  });
}

/** The first four pieces of artwork, in list order: the 2×2 mosaic. */
export function mosaicOf(entries: ReadonlyArray<{ artworkUrl: string | null }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.artworkUrl && !out.includes(e.artworkUrl)) out.push(e.artworkUrl);
    if (out.length === 4) break;
  }
  return out;
}

export function buildSidecar(fields: Omit<PlaylistSidecar, 'format' | 'version' | 'covers'>): PlaylistSidecar {
  return { format: PLAYLIST_SIDECAR_FORMAT, version: 1, ...fields, covers: mosaicOf(fields.entries) };
}

/** Is this song already in the list? By catalog id, ISRC, or the same location. */
export function sameSong(entry: Pick<PlaylistSidecarEntry, 'catalogId' | 'isrc' | 'location'>, probe: { catalogId?: string | null | undefined; isrc?: string | null | undefined; location?: string | null | undefined }): boolean {
  if (probe.catalogId && entry.catalogId === probe.catalogId) return true;
  if (probe.isrc && entry.isrc && entry.isrc.toUpperCase() === probe.isrc.toUpperCase()) return true;
  return Boolean(probe.location && entry.location === probe.location);
}
