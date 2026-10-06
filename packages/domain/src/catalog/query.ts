/**
 * What someone typed: free text, the advanced Track / Artist / Album fields, an ISRC, or a link to
 * music on one of the platforms the catalog can read.
 */
import type { CatalogPlatform, CatalogQuery } from '@now-playing/contracts';

/** Two letters (country), three alphanumerics (registrant), two digits (year), five digits. */
export const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/i;

/** An ISRC as written anywhere ("us-qx9-13-00108", lower case) in its canonical form, or null. */
export function normaliseIsrc(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.trim().replace(/[-\s]/g, '').toUpperCase();
  return ISRC_PATTERN.test(compact) ? compact : null;
}

export type MusicLinkKind = 'track' | 'album' | 'playlist' | 'artist' | 'unknown';

export interface MusicLink {
  platform: CatalogPlatform;
  kind: MusicLinkKind;
  /** The platform's id for the item, when the address carries it. */
  id: string | null;
  /** The address, made https and canonical where that is safe. */
  url: string;
}

function hostIs(host: string, ...names: string[]): boolean {
  return names.some((name) => host === name || host.endsWith(`.${name}`));
}

/**
 * A link to music, or null. Only http(s) addresses on the platforms below count, so a query that
 * merely contains "spotify.com" is still searched as text. `spotify:track:…` URIs are read too.
 */
export function parseMusicLink(input: string): MusicLink | null {
  const text = input.trim();
  const uri = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]{10,40})$/.exec(text);
  if (uri) return { platform: 'spotify', kind: uri[1] as MusicLinkKind, id: uri[2]!, url: `https://open.spotify.com/${uri[1]}/${uri[2]}` };
  if (!/^https?:\/\//i.test(text) || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  url.protocol = 'https:';
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  const segments = path.split('/').filter(Boolean);
  const href = url.toString();

  if (hostIs(host, 'open.spotify.com', 'play.spotify.com')) {
    const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/.exec(path);
    return m ? { platform: 'spotify', kind: m[1] as MusicLinkKind, id: m[2]!, url: `https://open.spotify.com/${m[1]}/${m[2]}` } : { platform: 'spotify', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'music.apple.com', 'itunes.apple.com')) {
    const track = url.searchParams.get('i');
    const song = /\/song\/(?:[^/]+\/)?(\d+)/.exec(path);
    const album = /\/album\/(?:[^/]+\/)?(?:id)?(\d+)/.exec(path);
    const playlist = /\/playlist\/(?:[^/]+\/)?(pl\.[A-Za-z0-9.-]+)/.exec(path);
    const artist = /\/artist\/(?:[^/]+\/)?(?:id)?(\d+)/.exec(path);
    if (track && /^\d+$/.test(track)) return { platform: 'apple-music', kind: 'track', id: track, url: href };
    if (song) return { platform: 'apple-music', kind: 'track', id: song[1]!, url: href };
    if (album) return { platform: 'apple-music', kind: 'album', id: album[1]!, url: href };
    if (playlist) return { platform: 'apple-music', kind: 'playlist', id: playlist[1]!, url: href };
    if (artist) return { platform: 'apple-music', kind: 'artist', id: artist[1]!, url: href };
    return { platform: 'apple-music', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'deezer.com', 'deezer.page.link')) {
    const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/(\d+)/.exec(path);
    return m ? { platform: 'deezer', kind: m[1] as MusicLinkKind, id: m[2]!, url: `https://www.deezer.com/${m[1]}/${m[2]}` } : { platform: 'deezer', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'music.youtube.com')) {
    const v = url.searchParams.get('v');
    const list = url.searchParams.get('list');
    if (path === '/watch' && v) return { platform: 'youtube-music', kind: 'track', id: v, url: `https://music.youtube.com/watch?v=${encodeURIComponent(v)}` };
    if (path === '/playlist' && list) return { platform: 'youtube-music', kind: list.startsWith('OLAK5uy_') ? 'album' : 'playlist', id: list, url: href };
    const browse = /^\/browse\/(MPREb_[A-Za-z0-9_-]+)/.exec(path);
    if (browse) return { platform: 'youtube-music', kind: 'album', id: browse[1]!, url: href };
    const channel = /^\/channel\/([A-Za-z0-9_-]+)/.exec(path);
    if (channel) return { platform: 'youtube-music', kind: 'artist', id: channel[1]!, url: href };
    return { platform: 'youtube-music', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'youtube.com', 'youtu.be')) {
    const v = host.endsWith('youtu.be') ? (segments[0] ?? null) : url.searchParams.get('v') ?? (/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{6,})/.exec(path)?.[1] ?? null);
    const list = url.searchParams.get('list');
    if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return { platform: 'youtube', kind: 'track', id: v, url: `https://www.youtube.com/watch?v=${encodeURIComponent(v)}` };
    if (list) return { platform: 'youtube', kind: list.startsWith('OLAK5uy_') ? 'album' : 'playlist', id: list, url: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}` };
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path)) return { platform: 'youtube', kind: 'artist', id: segments.join('/'), url: href };
    return { platform: 'youtube', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'soundcloud.com')) {
    // on.soundcloud.com short links say nothing until they are followed; yt-dlp follows them.
    if (host === 'on.soundcloud.com') return { platform: 'soundcloud', kind: 'unknown', id: segments[0] ?? null, url: href };
    url.search = '';
    const clean = url.toString();
    if (segments.length >= 3 && segments[1] === 'sets') return { platform: 'soundcloud', kind: 'playlist', id: `${segments[0]}/sets/${segments[2]}`, url: clean };
    if (segments.length >= 2 && !['tracks', 'albums', 'sets', 'reposts', 'likes', 'followers', 'following'].includes(segments[1]!)) return { platform: 'soundcloud', kind: 'track', id: `${segments[0]}/${segments[1]}`, url: clean };
    if (segments.length >= 1) return { platform: 'soundcloud', kind: 'artist', id: segments[0]!, url: clean };
    return { platform: 'soundcloud', kind: 'unknown', id: null, url: clean };
  }
  if (hostIs(host, 'bandcamp.com')) {
    const m = /^\/(track|album)\/([^/]+)/.exec(path);
    if (m) return { platform: 'bandcamp', kind: m[1] as MusicLinkKind, id: `${host}/${m[1]}/${m[2]}`, url: href };
    return { platform: 'bandcamp', kind: host === 'bandcamp.com' ? 'unknown' : 'artist', id: host, url: href };
  }
  if (hostIs(host, 'tidal.com')) {
    const m = /\/(track|album|playlist|artist)\/([A-Za-z0-9-]+)/.exec(path);
    return m ? { platform: 'tidal', kind: m[1] as MusicLinkKind, id: m[2]!, url: `https://tidal.com/browse/${m[1]}/${m[2]}` } : { platform: 'tidal', kind: 'unknown', id: null, url: href };
  }
  if (hostIs(host, 'qobuz.com')) {
    const m = /\/(album|track|playlist|artist|interpreter)\/(?:[^/]+\/)?([A-Za-z0-9]+)\/?$/.exec(path);
    if (m) return { platform: 'qobuz', kind: (m[1] === 'interpreter' ? 'artist' : m[1]) as MusicLinkKind, id: m[2]!, url: href };
    return { platform: 'qobuz', kind: 'unknown', id: null, url: href };
  }
  if (/^music\.amazon\.[a-z.]+$/.test(host) || (/^(www\.)?amazon\.[a-z.]+$/.test(host) && /^\/music\//.test(path))) {
    const trackAsin = url.searchParams.get('trackAsin');
    if (trackAsin) return { platform: 'amazon-music', kind: 'track', id: trackAsin, url: href };
    const m = /\/(albums|tracks|playlists|user-playlists|artists)\/([A-Z0-9]{10}|[a-z0-9]{20,})/i.exec(path);
    if (m) {
      const kind = ({ albums: 'album', tracks: 'track', playlists: 'playlist', 'user-playlists': 'playlist', artists: 'artist' } as const)[m[1]!.toLowerCase() as 'albums'];
      return { platform: 'amazon-music', kind, id: m[2]!, url: href };
    }
    return { platform: 'amazon-music', kind: 'unknown', id: null, url: href };
  }
  return null;
}

function field(value: string | null | undefined, max: number): string | null {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const s = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Read a query. A music link wins over everything (it is resolved, not searched); then an ISRC,
 * typed alone; then the advanced fields when any is filled — with free text, when there is some,
 * kept alongside; otherwise free text.
 */
export function parseCatalogQuery(input: { q?: string | null | undefined; track?: string | null | undefined; artist?: string | null | undefined; album?: string | null | undefined }): CatalogQuery {
  const q = field(input.q, 400) ?? '';
  const track = field(input.track, 200);
  const artist = field(input.artist, 200);
  const album = field(input.album, 200);
  const base = { track, artist, album, isrc: null, url: null };
  const link = q ? parseMusicLink(q) : null;
  if (link) return { kind: 'url', text: q, ...base, url: link.url };
  const isrc = !track && !artist && !album ? normaliseIsrc(q) : null;
  if (isrc) return { kind: 'isrc', text: isrc, track: null, artist: null, album: null, isrc, url: null };
  if (track || artist || album) return { kind: 'advanced', text: [q, track, artist, album].filter(Boolean).join(' '), ...base };
  return { kind: 'text', text: q, ...base };
}

/** The advanced fields as one line of text, for a service with no field syntax. */
export function queryText(query: CatalogQuery): string {
  return query.text;
}
