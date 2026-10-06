/**
 * Writes `catalog-stock.json`: what a hub or a companion's helper answers the music catalog
 * (DEC-039) for one search, in the contract's own shapes, for everything that draws the Search tab
 * without a network — the hub's and the companion's living mockups, the style guide's specimens,
 * the hub's end-to-end test and both apps' DOM tests.
 *
 * Invented music only (the player mockup's stock artists, `scripts/mockups/fixtures/
 * search-catalogue.json`), covers drawn as small SVGs (`coverFor`), previews at addresses that are
 * never fetched, and invented lyrics. Every answer is parsed by its contract before it is written.
 *
 *   pnpm exec tsx packages/aqua-ui/styleguide/fixtures/make-catalog-stock.mts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CatalogAlbumDetail,
  CatalogArtistDetail,
  CatalogEnrichment,
  CatalogLyrics,
  CatalogResolveResult,
  CatalogSearchChunk,
  CatalogSettingsView,
  SavedCollection,
  type CatalogAlbum,
  type CatalogArtist,
  type CatalogSource,
  type CatalogSourceStatus,
  type CatalogTrack,
} from '../../../contracts/src/index.js';
import { coverFor } from '../../../../scripts/mockups/lib/stock-search.mjs';

const RECORDED_AT = '2026-10-06T12:00:00.000Z';
const QUERY = {
  kind: 'text' as const,
  text: 'harbour',
  track: null,
  artist: null,
  album: null,
  isrc: null,
  url: null,
};

const src = (
  platform: CatalogSource['platform'],
  id: string,
  url: string,
  previewUrl: string | null = null,
  matchedBy: CatalogSource['matchedBy'] = 'search',
): CatalogSource => ({ platform, id, url, previewUrl, matchedBy });
const deezer = (id: number, preview = true) =>
  src(
    'deezer',
    String(id),
    `https://www.deezer.com/track/${id}`,
    preview ? `https://cdnt-preview.mockup.invalid/${id}.mp3` : null,
  );
const apple = (id: number) =>
  src(
    'apple-music',
    String(id),
    `https://music.apple.com/gb/song/${id}`,
    `https://audio.mockup.invalid/preview/${id}.m4a`,
  );
const ytm = (id: string, matchedBy: CatalogSource['matchedBy'] = 'search') =>
  src('youtube-music', id, `https://music.youtube.com/watch?v=${id}`, null, matchedBy);
const yt = (id: string) => src('youtube', id, `https://www.youtube.com/watch?v=${id}`);
const spotify = (id: string, matchedBy: CatalogSource['matchedBy']) =>
  src('spotify', id, `https://open.spotify.com/track/${id}`, null, matchedBy);
const mb = (id: string) => src('musicbrainz', id, `https://musicbrainz.org/recording/${id}`);

function track(
  id: string,
  title: string,
  artist: string,
  album: string,
  seconds: number,
  bpm: number | null,
  sources: CatalogSource[],
  rank: number,
  extra: Partial<CatalogTrack> = {},
): CatalogTrack {
  return {
    id,
    title,
    artist,
    artists: [artist],
    album,
    albumArtist: artist,
    durationMs: seconds * 1000,
    isrc: null,
    artworkUrl: coverFor(album),
    releaseDate: '2026-03-14',
    year: 2026,
    trackNumber: null,
    discNumber: 1,
    bpm,
    explicit: false,
    genre: null,
    label: null,
    sources,
    rank,
    ...extra,
  };
}

/* the songs, as they are once every service has answered */
const lights = track(
  'deezer:9101',
  'Harbour Lights',
  'Cassette Bloom',
  'Harbour Lights',
  214,
  118,
  [deezer(9101), apple(8101), ytm('mockHL0001')],
  140,
  { isrc: 'QZAAA2600101', trackNumber: 1, genre: 'Indie Pop' },
);
const wall = track(
  'deezer:9102',
  'Harbour Wall',
  'Cassette Bloom',
  'Harbour Lights',
  187,
  120,
  [deezer(9102), yt('mockHW0002')],
  120,
  { trackNumber: 2, explicit: true },
);
const ember = track(
  'deezer:9108',
  'Ember Season',
  'Cassette Bloom',
  'Harbour Lights',
  203,
  116,
  [deezer(9108)],
  60,
  { trackNumber: 3 },
);
const morning = track(
  'apple-music:8103',
  'Harbour Morning (Acoustic)',
  'Alder Quartet',
  'First Light Sessions',
  212,
  92,
  [apple(8103), spotify('0MockHarbourMorning01', 'musicbrainz'), ytm('mockHM0003')],
  118,
  { releaseDate: '2025-11-02', year: 2025 },
);
const side = track(
  'youtube:mockHS0004',
  'Harbourside',
  'Birch Ensemble',
  'Late Shift (Demos)',
  233,
  null,
  [yt('mockHS0004')],
  90,
  { album: null, artworkUrl: coverFor('Late Shift (Demos)'), releaseDate: null, year: null },
);
const paper = track(
  'youtube:mockPH0005',
  'Paper Harbour (Live)',
  'Birch Ensemble',
  'Live at the Granary',
  251,
  null,
  [yt('mockPH0005')],
  84,
  { album: null, artworkUrl: coverFor('Live at the Granary'), releaseDate: null, year: null },
);
const fog = track(
  'deezer:9106',
  'Harbour Fog',
  'Low Tide Signal',
  'Coastal Static',
  302,
  76,
  [deezer(9106), mb('0f0c0a00-0000-4000-8000-000000009106')],
  110,
  { releaseDate: '2024-06-21', year: 2024 },
);
const night = track(
  'apple-music:8107',
  'Night Harbour',
  'Velvet Orchard',
  'Small Hours',
  198,
  null,
  [apple(8107)],
  100,
  { releaseDate: '2025-02-07', year: 2025 },
);
const waltz = track(
  'deezer:9116',
  'Harbour Waltz',
  'Fennel Grove Trio',
  'Brass & Bramble',
  189,
  81,
  [deezer(9116)],
  50,
  { releaseDate: '2022-05-13', year: 2022 },
);
const ferry = track(
  'deezer:9122',
  'Morning Ferry',
  'Quiet Atlas',
  'Paper Maps',
  182,
  106,
  [deezer(9122)],
  40,
  { releaseDate: '2023-09-01', year: 2023 },
);
const lantern = track(
  'apple-music:8119',
  'Lantern Street',
  'Quiet Atlas',
  'Paper Maps',
  236,
  100,
  [apple(8119)],
  38,
  { releaseDate: '2023-09-01', year: 2023 },
);

const artist = (
  id: string,
  name: string,
  sources: CatalogSource[],
  patch: Partial<CatalogArtist>,
): CatalogArtist => ({
  id,
  name,
  pictureUrl: coverFor(`${name} portrait`),
  albumCount: null,
  fans: null,
  genre: null,
  sources,
  rank: 0,
  ...patch,
});
const bloom = artist(
  'deezer:9301',
  'Cassette Bloom',
  [src('deezer', '9301', 'https://www.deezer.com/artist/9301')],
  { albumCount: 3, fans: 18_400, genre: 'Indie Pop', rank: 130 },
);
const alder = artist(
  'apple-music:8301',
  'Alder Quartet',
  [src('apple-music', '8301', 'https://music.apple.com/gb/artist/8301')],
  { genre: 'Folk', rank: 100, pictureUrl: null },
);
const birch = artist(
  'deezer:9302',
  'Birch Ensemble',
  [src('deezer', '9302', 'https://www.deezer.com/artist/9302')],
  { albumCount: 2, fans: 2_150, genre: 'Jazz', rank: 90 },
);

const album = (
  id: string,
  title: string,
  artistName: string,
  sources: CatalogSource[],
  patch: Partial<CatalogAlbum>,
): CatalogAlbum => ({
  id,
  title,
  artist: artistName,
  artworkUrl: coverFor(title),
  releaseDate: null,
  year: null,
  trackCount: null,
  label: null,
  genre: null,
  explicit: false,
  upc: null,
  sources,
  rank: 0,
  ...patch,
});
const lightsAlbum = album(
  'deezer:9201',
  'Harbour Lights',
  'Cassette Bloom',
  [
    src('deezer', '9201', 'https://www.deezer.com/album/9201'),
    src('apple-music', '8201', 'https://music.apple.com/gb/album/8201'),
  ],
  {
    releaseDate: '2026-03-14',
    year: 2026,
    trackCount: 3,
    label: 'Pier Records',
    genre: 'Indie Pop',
    rank: 130,
  },
);
const sessions = album(
  'apple-music:8202',
  'First Light Sessions',
  'Alder Quartet',
  [src('apple-music', '8202', 'https://music.apple.com/gb/album/8202')],
  { releaseDate: '2025-11-02', year: 2025, trackCount: 6, rank: 100 },
);

const at = (
  state: CatalogSourceStatus['state'],
  provider: CatalogSourceStatus['provider'],
  count = 0,
  latencyMs: number | null = null,
  patch: Partial<CatalogSourceStatus> = {},
): CatalogSourceStatus => ({
  provider,
  state,
  count,
  latencyMs,
  error: null,
  retryAt: null,
  ...patch,
});
const resting = at('cooling-down', 'soundcloud', 0, null, {
  error: 'SoundCloud failed twice in a row, so it is being left alone for a while.',
  retryAt: '2026-10-06T12:03:00.000Z',
});

const statusAfter = (n: number): CatalogSourceStatus[] => [
  n >= 1 ? at('ok', 'itunes', 3, 310) : at('pending', 'itunes'),
  n >= 2 ? at('ok', 'deezer', 6, 240) : at('pending', 'deezer'),
  n >= 4 ? at('ok', 'musicbrainz', 1, 1180) : at('pending', 'musicbrainz'),
  n >= 3 ? at('ok', 'youtube', 4, 2400) : at('pending', 'youtube'),
  resting,
];

const only = (t: CatalogTrack, keep: CatalogSource['platform'][]): CatalogTrack => ({
  ...t,
  sources: t.sources.filter((s) => keep.includes(s.platform)),
});

const search = [
  {
    type: 'results',
    seq: 0,
    provider: null,
    query: QUERY,
    tracks: [],
    artists: [],
    albums: [],
    status: statusAfter(0),
  },
  {
    type: 'results',
    seq: 1,
    provider: 'itunes',
    query: QUERY,
    tracks: [
      { ...only(lights, ['apple-music']), id: 'deezer:9101' },
      only(morning, ['apple-music']),
      night,
    ],
    artists: [alder],
    albums: [sessions],
    status: statusAfter(1),
  },
  {
    type: 'results',
    seq: 2,
    provider: 'deezer',
    query: QUERY,
    tracks: [
      only(lights, ['deezer', 'apple-music']),
      only(wall, ['deezer']),
      only(fog, ['deezer']),
      ember,
      waltz,
    ],
    artists: [bloom, birch],
    albums: [lightsAlbum],
    status: statusAfter(2),
  },
  {
    type: 'results',
    seq: 3,
    provider: 'youtube',
    query: QUERY,
    tracks: [lights, wall, only(morning, ['apple-music', 'youtube-music']), side, paper],
    artists: [],
    albums: [],
    status: statusAfter(3),
  },
  {
    type: 'results',
    seq: 4,
    provider: 'musicbrainz',
    query: QUERY,
    tracks: [fog],
    artists: [],
    albums: [],
    status: statusAfter(4),
  },
  // The best rows' other homes, from MusicBrainz's links: Spotify for one song.
  {
    type: 'results',
    seq: 5,
    provider: null,
    query: QUERY,
    tracks: [morning],
    artists: [],
    albums: [],
    status: statusAfter(4),
  },
  {
    type: 'done',
    seq: 6,
    query: QUERY,
    status: statusAfter(4),
    page: {
      tracks: { offset: 0, limit: 25, hasMore: true },
      artists: { offset: 0, limit: 25, hasMore: false },
      albums: { offset: 0, limit: 25, hasMore: false },
    },
    totals: { tracks: 9, artists: 3, albums: 2 },
    resolve: null,
    // Spotify came only as MusicBrainz's link for one song: linked, not searched.
    linkedOnly: ['spotify'],
  },
];

/* See All ▸ Songs, the next page: one song already shown (dropped by id), two more */
const page2 = [
  {
    type: 'results',
    seq: 0,
    provider: null,
    query: QUERY,
    tracks: [],
    artists: [],
    albums: [],
    status: statusAfter(0),
  },
  {
    type: 'results',
    seq: 1,
    provider: 'deezer',
    query: QUERY,
    tracks: [only(wall, ['deezer']), ferry],
    artists: [],
    albums: [],
    status: statusAfter(2),
  },
  {
    type: 'results',
    seq: 2,
    provider: 'itunes',
    query: QUERY,
    tracks: [lantern],
    artists: [],
    albums: [],
    status: statusAfter(4),
  },
  {
    type: 'done',
    seq: 3,
    query: QUERY,
    status: statusAfter(4),
    page: { tracks: { offset: 25, limit: 25, hasMore: false }, artists: null, albums: null },
    totals: { tracks: 3, artists: 0, albums: 0 },
    resolve: null,
  },
];

/* a pasted Spotify playlist: done alone, naming it for resolve */
const PLAYLIST_URL = 'https://open.spotify.com/playlist/0MockHarbourMix0000001';
const linkQuery = {
  kind: 'url' as const,
  text: PLAYLIST_URL,
  track: null,
  artist: null,
  album: null,
  isrc: null,
  url: PLAYLIST_URL,
};
const link = [
  {
    type: 'done',
    seq: 0,
    query: linkQuery,
    status: [],
    page: { tracks: null, artists: null, albums: null },
    totals: { tracks: 0, artists: 0, albums: 0 },
    resolve: PLAYLIST_URL,
  },
];

const spotifyOnly = (t: CatalogTrack, n: number, id: string): CatalogTrack => ({
  ...t,
  id: `spotify:${id}`,
  trackNumber: n,
  bpm: null,
  rank: 0,
  sources: [spotify(id, 'link')],
});
const mixTracks = [
  spotifyOnly(lights, 1, '0MockSpotifyTrack00001'),
  spotifyOnly(morning, 2, '0MockSpotifyTrack00002'),
  spotifyOnly(fog, 3, '0MockSpotifyTrack00003'),
  spotifyOnly(night, 4, '0MockSpotifyTrack00004'),
  spotifyOnly(ferry, 5, '0MockSpotifyTrack00005'),
  spotifyOnly(side, 6, '0MockSpotifyTrack00006'),
];
const mixRef = {
  platform: 'spotify' as const,
  kind: 'playlist' as const,
  id: '0MockHarbourMix0000001',
  url: PLAYLIST_URL,
  title: 'Harbour Mix',
  owner: 'Airwave',
};
const mix = {
  ref: mixRef,
  artworkUrl: coverFor('Harbour Mix'),
  covers: mixTracks.slice(0, 4).map((t) => t.artworkUrl!),
  releaseDate: null,
  page: { tracks: mixTracks, offset: 0, limit: 50, total: 6, hasMore: false, capped: false },
};

const document = {
  about:
    'What a hub or a companion helper answers the music catalog for one search ("harbour"), a further page, a pasted Spotify playlist and an Apple Music playlist link, an album, an artist, a song’s lyrics and details, the saved list and the settings — invented music, drawn covers, previews never fetched. Written by make-catalog-stock.mts; every answer parsed by its contract.',
  recordedAt: RECORDED_AT,
  query: 'harbour',
  playlistUrl: PLAYLIST_URL,
  unsupportedUrl: 'https://music.apple.com/gb/playlist/harbour-evenings/pl.mock0000000000000001',
  search: CatalogSearchChunk.array().parse(search),
  searchPage2: CatalogSearchChunk.array().parse(page2),
  searchLink: CatalogSearchChunk.array().parse(link),
  resolvePlaylist: CatalogResolveResult.parse({
    url: PLAYLIST_URL,
    platform: 'spotify',
    kind: 'playlist',
    track: null,
    collection: mix,
    artist: null,
    reason: null,
    resolvedAt: RECORDED_AT,
  }),
  resolveUnsupported: CatalogResolveResult.parse({
    url: 'https://music.apple.com/gb/playlist/harbour-evenings/pl.mock0000000000000001',
    platform: 'apple-music',
    kind: 'unsupported',
    reason:
      'Apple Music playlists are not in Apple’s public API, so this one can’t be listed. Paste its songs’ own links, or an album’s.',
    resolvedAt: RECORDED_AT,
  }),
  album: CatalogAlbumDetail.parse({
    album: lightsAlbum,
    page: {
      tracks: [lights, wall, ember],
      offset: 0,
      limit: 50,
      total: 3,
      hasMore: false,
      capped: false,
    },
    collection: {
      platform: 'deezer',
      kind: 'album',
      id: '9201',
      url: 'https://www.deezer.com/album/9201',
      title: 'Harbour Lights',
      owner: 'Cassette Bloom',
    },
  }),
  artist: CatalogArtistDetail.parse({
    artist: bloom,
    topTracks: [lights, wall, ember],
    albums: [lightsAlbum],
    albumsPage: { offset: 0, limit: 12, hasMore: false },
  }),
  lyrics: CatalogLyrics.parse({
    found: true,
    source: 'lrclib',
    id: 900001,
    instrumental: false,
    synced:
      '[00:12.40] The lamps come on along the quay\n[00:18.90] One by one they count the boats\n[00:25.10] And every light is meant for me\n[00:31.60] \n[00:33.00] Harbour lights, harbour lights',
    plain:
      'The lamps come on along the quay\nOne by one they count the boats\nAnd every light is meant for me\n\nHarbour lights, harbour lights',
    trackName: 'Harbour Lights',
    artistName: 'Cassette Bloom',
    durationSec: 214,
  }),
  enrich: CatalogEnrichment.parse({
    isrc: 'QZAAA2600101',
    musicbrainzRecordingId: '0f0c0a00-0000-4000-8000-000000009101',
    genre: 'Indie Pop',
    genres: ['indie pop', 'dream pop'],
    label: 'Pier Records',
    releaseDate: '2026-03-14',
    year: 2026,
    sources: [],
  }),
  saved: {
    items: SavedCollection.array().parse([
      {
        ref: mixRef,
        savedAt: '2026-10-05T18:20:00.000Z',
        artworkUrl: mix.artworkUrl,
        covers: mix.covers,
        trackCount: 6,
      },
    ]),
  },
  settings: CatalogSettingsView.parse({
    embedLyrics: true,
    providers: { itunes: true, deezer: true, musicbrainz: true, youtube: true, soundcloud: true },
    odesliKeyConfigured: false,
  }),
};

const out = join(import.meta.dirname, 'catalog-stock.json');
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.info(`wrote ${out}`);
