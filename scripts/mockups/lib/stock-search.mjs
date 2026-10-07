/**
 * Stock music for the player's search, so the search in the mockup has something to show.
 *
 * The shell searches the music catalog (DEC-039): the paired hub, else the companion on this PC —
 * which is how the capture runs it — else this browser. The capture answers the companion's
 * `/helper/v1/catalog/*` from `fixtures/search-catalogue.json` in the catalog's own shapes (NDJSON
 * chunks for a search, details, lyrics, enrichment, a pasted playlist), so the captured search states
 * are the shell's real popover; the mockup's search behaviour (`behaviours/player-search.js`) filters
 * the same songs as you type. Deezer's JSONP tempo lookup is answered too (`deezerAnswer`). Public
 * playlists (the catalog's Playlists section, UX-CAT-005) are the fixture's stock playlists, each made
 * of stock songs; one opens through its Deezer-style link (`catalogResolve`).
 *
 * Artwork is a small generated SVG per album (a gradient and the album's initials), written as a
 * data: URI so the mockup needs no network. Previews are addresses that are never fetched.
 */
import catalogueFile from '../fixtures/search-catalogue.json' with { type: 'json' };

const hueOf = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const initials = (text) =>
  text
    .replace(/\(.*?\)/g, '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

/** A 200×200 cover: the album's own colours and initials. */
export function coverFor(album) {
  const h = hueOf(album);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h},58%,64%)"/><stop offset="1" stop-color="hsl(${(h + 48) % 360},62%,30%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="200" height="200" fill="url(#g)"/>` +
    `<circle cx="146" cy="58" r="36" fill="hsl(${(h + 180) % 360},70%,88%)" fill-opacity=".35"/>` +
    `<circle cx="146" cy="58" r="9" fill="#fff" fill-opacity=".5"/>` +
    `<text x="18" y="178" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="#fff" fill-opacity=".92">${initials(album)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Every stock song with its cover and a preview address (never fetched). */
export const CATALOGUE = catalogueFile.songs.map((s, i) => ({
  ...s,
  id: 9100 + i,
  art: coverFor(s.al),
  prev: `https://audio.mockup.invalid/preview/${9100 + i}.m4a`,
}));

/** Every word of the query appears in the title, artist or album — as iTunes matches a term. */
export function matches(song, query) {
  const hay = `${song.t} ${song.a} ${song.al}`.toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** The iTunes Search API's answer for `term`, in its own shape. */
export function itunesAnswer(term) {
  const results = CATALOGUE.filter((s) => matches(s, term)).map((s) => ({
    wrapperType: 'track',
    kind: 'song',
    trackId: s.id,
    trackName: s.t,
    artistName: s.a,
    collectionName: s.al,
    trackViewUrl: `https://music.apple.com/us/album/stock/${s.id}?i=${s.id}`,
    artworkUrl100: s.art,
    previewUrl: s.prev,
    trackTimeMillis: s.d * 1000,
    primaryGenreName: s.genre,
  }));
  return { resultCount: results.length, results };
}

/** Deezer's JSONP answers the shell reads a tempo from: a search, then that track. */
export function deezerAnswer(url) {
  const callback = url.searchParams.get('callback') || 'callback';
  let body = { data: [] };
  const track = /^\/track\/(\d+)$/.exec(url.pathname);
  if (track) {
    const song = CATALOGUE.find((s) => s.id === Number(track[1]));
    body = song ? { id: song.id, bpm: song.bpm, duration: song.d } : { error: {} };
  } else if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const song = CATALOGUE.find((s) => q === `${s.a} ${s.t}`.toLowerCase() || q === s.t.toLowerCase());
    if (song) body = { data: [{ id: song.id, duration: song.d }] };
  }
  return `${callback}(${JSON.stringify(body)});`;
}

/* ------------------------------------------------- the catalog, in its own shapes */

const ALBUM_NAMES = [...new Set(CATALOGUE.map((s) => s.al))];
const ARTIST_NAMES = [...new Set(CATALOGUE.map((s) => s.a))];
const albumId = (name) => `deezer:${8000 + ALBUM_NAMES.indexOf(name)}`;
const artistId = (name) => `deezer:${7000 + ARTIST_NAMES.indexOf(name)}`;
const albumInfo = (name) => catalogueFile.albums[name] ?? { year: 2020, label: null };
const NOW = '2026-09-12T18:30:00.000Z';

const source = (platform, id, extra = {}) => ({ platform, id: String(id), url: `https://${platform}.mockup.invalid/${id}`, previewUrl: null, matchedBy: 'search', ...extra });

/** Where a stock song "is": Deezer and Apple for most, YouTube Music for some, one Spotify link from MusicBrainz. */
function sourcesOf(s, i) {
  const out = [source('deezer', s.id, { previewUrl: s.prev }), source('apple-music', s.id + 500)];
  if (i % 3 === 0) out.push(source('youtube-music', `ym${s.id}`));
  if (i % 3 === 1) out.push(source('youtube', `yt${s.id}`));
  if (i === 6) out.push(source('spotify', `sp${s.id}`, { matchedBy: 'musicbrainz' }));
  return out;
}

export function catalogTrack(s) {
  const i = CATALOGUE.indexOf(s);
  const info = albumInfo(s.al);
  return {
    id: `deezer:${s.id}`,
    title: s.t,
    artist: s.a,
    artists: [s.a],
    album: s.al,
    albumArtist: s.a,
    durationMs: s.d * 1000,
    isrc: `QZMOK${String(info.year).slice(2)}${String(s.id).padStart(5, '0')}`,
    artworkUrl: s.art,
    releaseDate: `${info.year}-04-1${i % 9}`,
    year: info.year,
    trackNumber: CATALOGUE.filter((x) => x.al === s.al).indexOf(s) + 1,
    discNumber: 1,
    bpm: s.bpm,
    explicit: false,
    genre: s.genre,
    label: info.label,
    sources: sourcesOf(s, i),
    rank: 200 - i,
  };
}

function catalogAlbumRow(name) {
  const songs = CATALOGUE.filter((s) => s.al === name);
  const info = albumInfo(name);
  return {
    id: albumId(name),
    title: name,
    artist: songs[0].a,
    artworkUrl: coverFor(name),
    releaseDate: `${info.year}-04-10`,
    year: info.year,
    trackCount: songs.length,
    label: info.label,
    genre: songs[0].genre,
    explicit: false,
    upc: null,
    sources: [source('deezer', 8000 + ALBUM_NAMES.indexOf(name)), source('apple-music', 8500 + ALBUM_NAMES.indexOf(name))],
    rank: 100 - ALBUM_NAMES.indexOf(name),
  };
}

function catalogArtistRow(name) {
  const songs = CATALOGUE.filter((s) => s.a === name);
  return {
    id: artistId(name),
    name,
    pictureUrl: coverFor(name),
    albumCount: new Set(songs.map((s) => s.al)).size,
    fans: 1200 + 317 * ARTIST_NAMES.indexOf(name),
    genre: songs[0].genre,
    sources: [source('deezer', 7000 + ARTIST_NAMES.indexOf(name))],
    rank: 100 - ARTIST_NAMES.indexOf(name),
  };
}

const PLAYLISTS = catalogueFile.playlists ?? [];
const playlistSongs = (pl) => pl.songs.map((t) => CATALOGUE.find((s) => s.t === t)).filter(Boolean);
const playlistUrl = (i) => `https://www.deezer.com/playlist/${6000 + i}`;

/** A public playlist as the catalog lists one (CatalogPlaylist): its own picture, no songs until opened. */
function catalogPlaylistRow(pl) {
  const i = PLAYLISTS.indexOf(pl);
  return {
    id: `deezer:${6000 + i}`,
    title: pl.title,
    owner: pl.owner,
    trackCount: pl.songs.length,
    pictureUrl: coverFor(pl.title),
    covers: [],
    sources: [{ platform: 'deezer', id: String(6000 + i), url: playlistUrl(i), previewUrl: null, matchedBy: 'search' }],
    rank: 100 - i,
  };
}

/** A playlist matches when its name does, or one of its songs does. */
const playlistMatches = (pl, words) => matches({ t: pl.title, a: pl.owner, al: '' }, words) || playlistSongs(pl).some((s) => matches(s, words));

const status = (provider, state, count, extra = {}) => ({ provider, state, count, latencyMs: state === 'pending' ? null : 300, error: null, retryAt: null, ...extra });

/** A search as the helper streams it: every service pending, then Deezer, then iTunes (merged), then done. */
export function catalogSearch(url) {
  const p = url.searchParams;
  const words = p.get('q') || [p.get('track'), p.get('artist'), p.get('album')].filter(Boolean).join(' ');
  const sections = (p.get('sections') || 'tracks,artists,albums,playlists').split(',');
  const offset = Number(p.get('offset') || 0);
  const limit = Number(p.get('limit') || 25);
  const hit = CATALOGUE.filter((s) => matches(s, words) || (p.get('q') && catalogTrack(s).isrc === p.get('q').toUpperCase()));
  const tracks = sections.includes('tracks') ? hit.slice(offset, offset + limit).map(catalogTrack) : [];
  const artists = sections.includes('artists') ? [...new Set(hit.map((s) => s.a))].slice(offset, offset + limit).map(catalogArtistRow) : [];
  const albums = sections.includes('albums') ? [...new Set(hit.map((s) => s.al))].slice(offset, offset + limit).map(catalogAlbumRow) : [];
  const lists = PLAYLISTS.filter((pl) => playlistMatches(pl, words));
  const playlists = sections.includes('playlists') ? lists.slice(offset, offset + limit).map(catalogPlaylistRow) : [];
  const query = { kind: p.get('q') ? 'text' : 'advanced', text: words, track: p.get('track'), artist: p.get('artist'), album: p.get('album'), isrc: null, url: null };
  const resting = { error: 'soundcloud.com asked to slow down', retryAt: '2026-09-12T18:35:00.000Z' };
  const start = [status('itunes', 'pending', 0), status('deezer', 'pending', 0), status('musicbrainz', 'pending', 0), status('youtube', 'pending', 0), status('soundcloud', 'cooling-down', 0, resting)];
  const final = [
    status('itunes', tracks.length ? 'ok' : 'empty', tracks.length),
    status('deezer', tracks.length + albums.length + playlists.length ? 'ok' : 'empty', tracks.length + artists.length + albums.length + playlists.length),
    status('musicbrainz', tracks.length ? 'ok' : 'empty', Math.min(tracks.length, 3)),
    status('youtube', 'ok', Math.ceil(tracks.length / 3)),
    status('soundcloud', 'cooling-down', 0, resting),
  ];
  const page = (s, n) => (sections.includes(s) ? { offset, limit, hasMore: offset + limit < n } : null);
  const chunks = [
    { type: 'results', seq: 0, provider: null, query, tracks: [], artists: [], albums: [], playlists: [], status: start },
    { type: 'results', seq: 1, provider: 'deezer', query, tracks, artists, albums, playlists, status: final },
    {
      type: 'done',
      seq: 2,
      query,
      status: final,
      page: { tracks: page('tracks', hit.length), artists: page('artists', new Set(hit.map((s) => s.a)).size), albums: page('albums', new Set(hit.map((s) => s.al)).size), playlists: page('playlists', lists.length) },
      totals: { tracks: tracks.length, artists: artists.length, albums: albums.length, playlists: playlists.length },
      resolve: null,
    },
  ];
  return chunks.map((c) => `${JSON.stringify(c)}\n`).join('');
}

const albumRef = (name) => ({ platform: 'deezer', kind: 'album', id: String(8000 + ALBUM_NAMES.indexOf(name)), url: `https://www.deezer.com/album/${8000 + ALBUM_NAMES.indexOf(name)}`, title: name, owner: CATALOGUE.find((s) => s.al === name).a });

export function catalogAlbum(url) {
  const name = ALBUM_NAMES[Number((url.searchParams.get('id') || '').split(':')[1]) - 8000];
  if (!name) return null;
  const tracks = CATALOGUE.filter((s) => s.al === name).map(catalogTrack);
  return { album: catalogAlbumRow(name), page: { tracks, offset: 0, limit: 100, total: tracks.length, hasMore: false, capped: false }, collection: albumRef(name) };
}

export function catalogArtist(url) {
  const name = ARTIST_NAMES[Number((url.searchParams.get('id') || '').split(':')[1]) - 7000];
  if (!name) return null;
  const songs = CATALOGUE.filter((s) => s.a === name);
  return { artist: catalogArtistRow(name), topTracks: songs.map(catalogTrack), albums: [...new Set(songs.map((s) => s.al))].map(catalogAlbumRow), albumsPage: { offset: 0, limit: 25, hasMore: false } };
}

export function catalogLyrics() {
  const lines = catalogueFile.lyrics;
  return { found: true, source: 'lrclib', id: 1, instrumental: false, synced: lines.map((l, i) => `[00:${String(12 + i * 5).padStart(2, '0')}.00] ${l}`).join('\n'), plain: lines.join('\n'), trackName: null, artistName: null, durationSec: null };
}

export function catalogEnrich(url) {
  const isrc = url.searchParams.get('isrc');
  const s = CATALOGUE.find((x) => catalogTrack(x).isrc === isrc) ?? CATALOGUE[0];
  const t = catalogTrack(s);
  return { isrc: t.isrc, musicbrainzRecordingId: '00000000-0000-4000-8000-00000000mock'.slice(0, 36), genre: s.genre, genres: [s.genre.toLowerCase()], label: t.label, releaseDate: t.releaseDate, year: t.year, sources: [source('spotify', `sp${s.id}`, { matchedBy: 'musicbrainz' })] };
}

/**
 * The pasted Spotify playlist: its songs Spotify's only (spotDL finds each on YouTube Music when
 * fetched). A stock playlist's own link (the Playlists section's rows) opens it the same way.
 */
export function catalogResolve(url) {
  const pl = catalogueFile.playlist;
  const link = url.searchParams.get('url');
  const own = /deezer\.com\/playlist\/(\d+)$/.exec(link || '');
  const stock = own ? PLAYLISTS[Number(own[1]) - 6000] : null;
  if (stock) {
    const i = PLAYLISTS.indexOf(stock);
    const tracks = playlistSongs(stock).map(catalogTrack);
    return {
      url: link,
      platform: 'deezer',
      kind: 'playlist',
      track: null,
      artist: null,
      reason: null,
      resolvedAt: NOW,
      collection: {
        ref: { platform: 'deezer', kind: 'playlist', id: String(6000 + i), url: playlistUrl(i), title: stock.title, owner: stock.owner },
        artworkUrl: coverFor(stock.title),
        covers: tracks.slice(0, 4).map((t) => t.artworkUrl),
        releaseDate: null,
        page: { tracks, offset: 0, limit: 200, total: tracks.length, hasMore: false, capped: false },
      },
    };
  }
  if (link !== pl.url) return { url: link, platform: null, kind: 'unsupported', track: null, collection: null, artist: null, reason: 'That is not a link to music on a platform the catalog reads.', resolvedAt: NOW };
  const songs = pl.songs.map((t) => CATALOGUE.find((s) => s.t === t));
  const tracks = songs.map((s) => ({ ...catalogTrack(s), id: `spotify:sp${s.id}`, sources: [source('spotify', `sp${s.id}`, { url: `https://open.spotify.com/track/sp${s.id}`, matchedBy: 'link' })] }));
  return {
    url: pl.url,
    platform: 'spotify',
    kind: 'playlist',
    track: null,
    artist: null,
    reason: null,
    resolvedAt: NOW,
    collection: {
      ref: { platform: 'spotify', kind: 'playlist', id: 'mockupHarbourNights', url: pl.url, title: pl.title, owner: pl.owner },
      artworkUrl: null,
      covers: tracks.slice(0, 4).map((t) => t.artworkUrl),
      releaseDate: null,
      page: { tracks, offset: 0, limit: 100, total: tracks.length, hasMore: false, capped: false },
    },
  };
}

/** What the mockup's search behaviour needs to fill the rows it copies: songs, artists and albums. */
export function behaviourData() {
  const label = { deezer: 'Deezer', 'apple-music': 'Apple Music', 'youtube-music': 'YouTube Music', youtube: 'YouTube', spotify: 'Spotify' };
  return {
    songs: CATALOGUE.map((s) => ({ t: s.t, a: s.a, al: s.al, d: s.d, bpm: s.bpm, art: s.art, year: albumInfo(s.al).year, pfs: [...new Set(sourcesOf(s, CATALOGUE.indexOf(s)).map((x) => label[x.platform]))] })),
    artists: ARTIST_NAMES.map((name) => {
      const a = catalogArtistRow(name);
      return { name, sub: [a.genre, `${a.albumCount} ${a.albumCount === 1 ? 'album' : 'albums'}`, `${a.fans.toLocaleString('en-US')} fans`].join(' · '), art: a.pictureUrl };
    }),
    albums: ALBUM_NAMES.map((name) => {
      const a = catalogAlbumRow(name);
      return { title: name, a: a.artist, sub: [a.artist, a.year, `${a.trackCount} ${a.trackCount === 1 ? 'song' : 'songs'}`].join(' · '), art: a.artworkUrl };
    }),
    playlists: PLAYLISTS.map((pl) => {
      const p = catalogPlaylistRow(pl);
      return { title: pl.title, songs: pl.songs, sub: ['Playlist on Deezer', pl.owner, `${p.trackCount} ${p.trackCount === 1 ? 'song' : 'songs'}`].join(' · '), art: p.pictureUrl };
    }),
  };
}
