/**
 * Public Spotify embed metadata: the fast path for playlists, and a fallback for tracks or albums
 * spotDL cannot read. The HTML exposes track metadata (not an audio stream); audioPreview is ignored.
 */
import { CATALOG_COLLECTION_CAP } from '@now-playing/contracts';
import type { LinkRead, LinkTrack } from '../links.js';
import { calendarDate, isObject, num, str, webUrl, type Json } from '../http.js';
import { parseMusicLink } from '../query.js';

const SPOTIFY_ID = /^[A-Za-z0-9]{10,40}$/;
/** Spotify's public embed response lists at most 100 tracks and carries no total for longer playlists. */
const SPOTIFY_EMBED_TRACK_LIMIT = 100;

function nextData(html: string): Json | null {
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let match = scripts.exec(html); match; match = scripts.exec(html)) {
    if (!/\bid=["']__NEXT_DATA__["']/i.test(match[1] ?? '')) continue;
    try {
      const value: unknown = JSON.parse(match[2] ?? '');
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function entityFrom(html: string): Json | null {
  const root = nextData(html);
  const props = root && isObject(root['props']) ? root['props'] : null;
  const pageProps = props && isObject(props['pageProps']) ? props['pageProps'] : null;
  const state = pageProps && isObject(pageProps['state']) ? pageProps['state'] : null;
  const data = state && isObject(state['data']) ? state['data'] : null;
  return data && isObject(data['entity']) ? data['entity'] : null;
}

function bestImage(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const images = value.filter(isObject).filter((image) => webUrl(image['url']));
  images.sort((a, b) => (num(b['maxWidth']) ?? num(b['width']) ?? 0) - (num(a['maxWidth']) ?? num(a['width']) ?? 0));
  return images.length ? webUrl(images[0]!['url']) : null;
}

function artworkOf(entity: Json): string | null {
  const visual = isObject(entity['visualIdentity']) ? entity['visualIdentity'] : null;
  const cover = isObject(entity['coverArt']) ? entity['coverArt'] : null;
  return bestImage(visual?.['image']) ?? bestImage(cover?.['sources']);
}

function artistsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => (isObject(item) ? str(item['name']) : str(item))).filter((name): name is string => Boolean(name));
  const joined = str(value)?.replace(/\u00a0/g, ' ');
  return joined ? joined.split(/\s*,\s*/).filter(Boolean) : [];
}

function ownerOf(entity: Json): string | null {
  const authors = artistsOf(entity['authors']);
  if (authors.length) return authors.join(', ');
  const subtitle = str(entity['subtitle']);
  return subtitle && !/^spotify$/i.test(subtitle) ? subtitle.replace(/\u00a0/g, ' ') : null;
}

function dateOf(value: unknown): string | null {
  return calendarDate(isObject(value) ? value['isoString'] : value);
}

function trackFrom(entity: Json, fallbackArtwork: string | null, album: string | null, trackNumber: number | null): LinkTrack | null {
  const uri = str(entity['uri'], 100);
  const uriId = uri ? /^spotify:track:([A-Za-z0-9]{10,40})$/.exec(uri)?.[1] : null;
  const id = uriId ?? (SPOTIFY_ID.test(str(entity['id'], 40) ?? '') ? str(entity['id'], 40) : null);
  const title = str(entity['title']) ?? str(entity['name']);
  if (!id || !title) return null;
  const artists = artistsOf(entity['artists'] ?? entity['subtitle']);
  const durationMs = num(entity['duration']);
  const entityArtwork = artworkOf(entity);
  const albumValue = entity['album'];
  const albumName = isObject(albumValue) ? str(albumValue['title']) ?? str(albumValue['name']) : str(albumValue);
  return {
    url: `https://open.spotify.com/track/${id}`,
    title,
    artist: artists[0] ?? null,
    featured: artists.slice(1, 20),
    album: albumName ?? album,
    durationSec: durationMs === null || durationMs === 0 ? null : durationMs / 1000,
    date: dateOf(entity['releaseDate']),
    artworkUrl: entityArtwork ?? fallbackArtwork,
    trackNumber,
    explicit: typeof entity['isExplicit'] === 'boolean' ? entity['isExplicit'] : null,
  };
}

/** Parse the public `__NEXT_DATA__` entity only when it matches the Spotify link being resolved. */
export function readSpotifyEmbed(html: string, url: string): LinkRead | null {
  const link = parseMusicLink(url);
  if (!link || link.platform !== 'spotify' || !link.id || !['track', 'album', 'playlist'].includes(link.kind)) return null;
  const entity = entityFrom(html);
  if (!entity || str(entity['id'], 40) !== link.id || str(entity['type']) !== link.kind) return null;
  if (!SPOTIFY_ID.test(link.id)) return null;

  if (link.kind === 'track') {
    const track = trackFrom(entity, artworkOf(entity), null, null);
    return track ? { kind: 'track', url: link.url, track } : null;
  }

  const trackList = entity['trackList'];
  if (!Array.isArray(trackList)) return null;
  const artworkUrl = artworkOf(entity);
  const title = str(entity['title']) ?? str(entity['name']) ?? (link.kind === 'album' ? 'Album' : 'Playlist');
  const tracks = trackList
    .filter(isObject)
    .map((track, index) => trackFrom(track, artworkUrl, link.kind === 'album' ? title : null, link.kind === 'album' ? index + 1 : null))
    .filter((track): track is LinkTrack => Boolean(track));
  const declaredTotal = num(entity['trackCount']);
  const knownTotal = declaredTotal !== null && Number.isInteger(declaredTotal) ? declaredTotal : null;
  const limit = Math.min(CATALOG_COLLECTION_CAP, SPOTIFY_EMBED_TRACK_LIMIT, knownTotal ?? Number.POSITIVE_INFINITY);
  const entries = tracks.slice(0, limit);
  const responseCapped = knownTotal === null && trackList.length >= SPOTIFY_EMBED_TRACK_LIMIT;
  const total = knownTotal ?? (responseCapped ? null : tracks.length);
  return {
    kind: 'collection',
    url: link.url,
    title,
    owner: ownerOf(entity),
    artworkUrl,
    date: dateOf(entity['releaseDate']),
    entries,
    total,
    capped: tracks.length > entries.length || responseCapped || (total !== null && total > entries.length),
  };
}
