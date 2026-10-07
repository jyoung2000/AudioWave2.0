/**
 * Apple Music playlists, read from their public page (owner decision, 2026-10-06: every platform's
 * playlists open). They are not in Apple's keyless API, but the playlist page anyone can open in a
 * browser carries its songs as data: a `serialized-server-data` JSON block whose sections hold the
 * header (`containerDetailHeaderLockup`) and the songs (`trackLockup`: title, the artists as
 * `subtitleLinks`, the album as `tertiaryLinks`, `duration` in ms, the song's id and address, and
 * its artwork as a `{w}x{h}bb.{f}` template), and a schema.org `MusicPlaylist` block with the count.
 *
 * Written fresh from that page's shape as seen on 2026-10-06 (the MusicSearch repository reads the
 * same page for the same reason, `applemusic.py`; none of its code is used — DEC-039). No token, no
 * account, no private API: one GET of the page a person would open. When Apple changes the page,
 * this says so in words (`ApplePageChanged`) instead of guessing.
 *
 * The page carries the songs it shows; a long playlist's page may carry only its first ones. The
 * count says how many there are, so a list that stops short is reported, never cut silently.
 */
import type { CatalogSource, CatalogTrack } from '@now-playing/contracts';
import { CatalogHttpError, getText, isObject, num, str, webUrl, type CatalogFetch, type Json } from '../http.js';

export class ApplePageChanged extends Error {
  constructor() {
    super('Apple Music’s playlist page no longer looks the way Airwave reads it, so this playlist can’t be listed until Airwave is updated. Albums and songs still open.');
    this.name = 'ApplePageChanged';
  }
}

export interface ApplePlaylistPage {
  title: string;
  owner: string | null;
  artworkUrl: string | null;
  /** How many songs Apple says the playlist holds; null when it does not say. */
  total: number | null;
  tracks: CatalogTrack[];
}

/** Apple's artwork template at 600×600, as the rest of the catalog shows covers. */
export function appleArtwork(template: unknown): string | null {
  const raw = str(template, 2048);
  if (!raw) return null;
  return webUrl(raw.replace('{w}', '600').replace('{h}', '600').replace('{c}', '').replace('{f}', 'jpg'));
}

function scriptJson(html: string, attribute: RegExp): unknown {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!attribute.test(m[1] ?? '')) continue;
    try {
      return JSON.parse(m[2] ?? '');
    } catch {
      return null;
    }
  }
  return null;
}

/** Every object under `value` (depth-first, bounded) — the page nests its sections differently over time. */
function* objects(value: unknown, depth = 0): Generator<Json> {
  if (depth > 8) return;
  if (Array.isArray(value)) for (const item of value) yield* objects(item, depth + 1);
  else if (isObject(value)) {
    yield value;
    for (const item of Object.values(value)) if (typeof item === 'object' && item !== null) yield* objects(item, depth + 1);
  }
}

function linkTitles(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map((l) => (isObject(l) ? str(l['title']) : null)).filter((t): t is string => Boolean(t));
}

function trackOf(item: Json, playlistId: string, index: number): CatalogTrack | null {
  const title = str(item['title']);
  const descriptor = isObject(item['contentDescriptor']) ? item['contentDescriptor'] : null;
  const ids = descriptor && isObject(descriptor['identifiers']) ? descriptor['identifiers'] : null;
  const id = str(ids?.['storeAdamID'], 40);
  const url = webUrl(descriptor?.['url']);
  if (!title || !url) return null;
  const artists = linkTitles(item['subtitleLinks']);
  const album = linkTitles(item['tertiaryLinks'])[0] ?? null;
  const artwork = isObject(item['artwork']) && isObject(item['artwork']['dictionary']) ? item['artwork']['dictionary']['url'] : null;
  const durationMs = num(item['duration']);
  const source: CatalogSource = { platform: 'apple-music', id: id ?? null, url, previewUrl: null, matchedBy: 'link' };
  return {
    id: `apple-music:${id ?? `${playlistId}#${index}`}`,
    title,
    artist: artists.length > 1 ? `${artists[0]} feat. ${artists.slice(1).join(' & ')}` : (artists[0] ?? ''),
    artists: artists.slice(0, 20),
    album,
    albumArtist: null,
    durationMs: durationMs !== null && durationMs > 0 ? Math.round(durationMs) : null,
    isrc: null,
    artworkUrl: appleArtwork(artwork),
    releaseDate: null,
    year: null,
    trackNumber: index + 1,
    discNumber: null,
    bpm: null,
    explicit: null,
    genre: null,
    label: null,
    sources: [source],
    rank: 0,
  };
}

/** A playlist page's songs and header. Throws `ApplePageChanged` when the data is not where it was. */
export function readApplePlaylistPage(html: string, playlistId: string): ApplePlaylistPage {
  const data = scriptJson(html, /id=["']?serialized-server-data/);
  const sections = [...objects(data)].filter((o) => typeof o['itemKind'] === 'string' && Array.isArray(o['items']));
  const songs = sections.filter((s) => /^trackLockup$/i.test(String(s['itemKind'])));
  if (!songs.length) throw new ApplePageChanged();
  const tracks: CatalogTrack[] = [];
  for (const section of songs) for (const item of section['items'] as unknown[]) if (isObject(item)) {
    const track = trackOf(item, playlistId, tracks.length);
    if (track) tracks.push(track);
  }
  const header = sections.find((s) => /containerDetailHeader/i.test(String(s['itemKind'])));
  const head = header && isObject((header['items'] as unknown[])[0]) ? ((header['items'] as unknown[])[0] as Json) : null;
  const schema = scriptJson(html, /schema:music-playlist|application\/ld\+json/);
  const ld = isObject(schema) ? schema : null;
  const art = head && isObject(head['artwork']) && isObject(head['artwork']['dictionary']) ? head['artwork']['dictionary']['url'] : null;
  const author = ld && isObject(ld['author']) ? str(ld['author']['name']) : null;
  const total = num(ld?.['numTracks']);
  return {
    title: str(head?.['title']) ?? str(ld?.['name']) ?? 'Playlist',
    owner: linkTitles(head?.['subtitleLinks'])[0] ?? author,
    artworkUrl: appleArtwork(art),
    total: total !== null && Number.isInteger(total) ? total : null,
    tracks,
  };
}

/** GET the public page and read it. Network failures are the caller's to say; a changed page is `ApplePageChanged`. */
export async function fetchApplePlaylistPage(fetchImpl: CatalogFetch, url: string, playlistId: string, options: { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<ApplePlaylistPage | null> {
  const page = new URL(url);
  page.search = '';
  const { status, body } = await getText(fetchImpl, page.toString(), { timeoutMs: options.timeoutMs, signal: options.signal, accept: [404] });
  if (status === 404) return null;
  if (!body.includes('serialized-server-data')) throw new ApplePageChanged();
  try {
    return readApplePlaylistPage(body, playlistId);
  } catch (error) {
    if (error instanceof ApplePageChanged) throw error;
    throw new CatalogHttpError('Apple Music’s playlist page could not be read', 'parse');
  }
}
