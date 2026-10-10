/**
 * The music catalog: one search across the keyless music services, and what the apps can ask about
 * what it finds (DEC-039).
 *
 * Search is about music. It finds songs, artists and albums and says where each one is — every
 * result carries `sources`, one entry per platform it was found on — and it never offers to "search
 * YouTube for this" (UX-CAT-003). The same shapes are served by the hub (`/api/v1/catalog/*`) and by
 * the local helper (`/helper/v1/catalog/*`), and the engine behind both is
 * `@now-playing/domain/catalog`, so the player can run parts of it itself.
 *
 * A search is streamed as NDJSON: one `CatalogSearchChunk` per line, as each service answers. A
 * `results` chunk upserts tracks, artists and albums by `id` (a later chunk can carry a row seen
 * before, now merged with another service's copy of the same song); a `done` chunk closes the
 * stream with every service's final status. `?stream=0` answers with one `CatalogSearchAggregate`.
 *
 * One song is one row (UX-CAT-002): the same recording from iTunes, Deezer, a YouTube official
 * video or Topic upload and SoundCloud is merged into one track carrying every platform; a live
 * version, a remix, an acoustic or instrumental take, a demo, a radio edit, an extended mix, a sped
 * up or slowed edit, karaoke and covers stay rows of their own. **Across pages:** the server keeps
 * each query's rows (same words and services, any sections) for 15 minutes; a later page's song that
 * is the same recording as one already sent comes back **with that row's id** — an upsert of the
 * earlier row, never a new row — so page 2 never repeats page 1. A client that pages after the
 * session has lapsed should still drop rows by id and `sameRecording` (`appendTracks`).
 */
import { z } from 'zod';
import { CalendarDate, IsoDateTime } from '../common.js';

/** Where a result lives. Ids, not labels: `CATALOG_PLATFORM_LABELS` says them in words. */
export const CatalogPlatform = z.enum(['apple-music', 'deezer', 'musicbrainz', 'youtube', 'youtube-music', 'soundcloud', 'spotify', 'bandcamp', 'tidal', 'qobuz', 'amazon-music']);
export type CatalogPlatform = z.infer<typeof CatalogPlatform>;

export const CATALOG_PLATFORM_LABELS: Record<CatalogPlatform, string> = {
  'apple-music': 'Apple Music',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  youtube: 'YouTube',
  'youtube-music': 'YouTube Music',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  bandcamp: 'Bandcamp',
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  'amazon-music': 'Amazon Music',
};

/** The services a search asks. All keyless; YouTube and SoundCloud go through yt-dlp on the server. */
export const CatalogProviderId = z.enum(['itunes', 'deezer', 'musicbrainz', 'youtube', 'soundcloud']);
export type CatalogProviderId = z.infer<typeof CatalogProviderId>;
export const CATALOG_PROVIDERS: readonly CatalogProviderId[] = CatalogProviderId.options;

/** The three item sections every catalog client draws: songs, artists and albums. */
export const CatalogSection = z.enum(['tracks', 'artists', 'albums']);
export type CatalogSection = z.infer<typeof CatalogSection>;

/**
 * Everything a search can be asked for (`sections=`): the item sections and `playlists` — public
 * playlists, keyless from Deezer (owner requirement, 2026-10-07; UX-CAT-005). Older clients that
 * draw only the three item sections keep `CatalogSection`; the stream's `playlists` arrays and page
 * default to empty and null, so their chunks still parse.
 */
export const CatalogSearchSection = z.enum(['tracks', 'artists', 'albums', 'playlists']);
export type CatalogSearchSection = z.infer<typeof CatalogSearchSection>;
export const CATALOG_SEARCH_SECTIONS: readonly CatalogSearchSection[] = CatalogSearchSection.options;

/**
 * How a source was tied to the song: found by that service's own search (`search`), by the same
 * ISRC (`isrc`), by artist, title and duration (`metadata`), by a MusicBrainz link (`musicbrainz`),
 * by spotDL's own YouTube Music match (`spotdl`), or by SongLink (`odesli`).
 */
export const CatalogMatch = z.enum(['search', 'isrc', 'metadata', 'musicbrainz', 'spotdl', 'odesli', 'link']);
export type CatalogMatch = z.infer<typeof CatalogMatch>;

export const CatalogSource = z.object({
  platform: CatalogPlatform,
  /** The platform's own id for the item, when it has one. */
  id: z.string().max(200).nullable(),
  url: z.string().max(2048),
  /** A DRM-free clip (iTunes, Deezer: 30 s), when the platform offers one. */
  previewUrl: z.string().max(2048).nullable().default(null),
  matchedBy: CatalogMatch.default('search'),
});
export type CatalogSource = z.infer<typeof CatalogSource>;

/** A song, merged across every service that had it (UX-CAT-002). */
export const CatalogTrack = z.object({
  /** Stable for the life of a search: the first source's `platform:id`. Chunks upsert by it. */
  id: z.string().max(260),
  title: z.string().max(300),
  /** The credited artist line, as the richest source wrote it. */
  artist: z.string().max(300),
  artists: z.array(z.string().max(300)).max(20).default([]),
  album: z.string().max(300).nullable().default(null),
  albumArtist: z.string().max(300).nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  isrc: z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/).nullable().default(null),
  artworkUrl: z.string().max(2048).nullable().default(null),
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  releaseDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable().default(null),
  year: z.number().int().min(1000).max(3000).nullable().default(null),
  trackNumber: z.number().int().positive().nullable().default(null),
  discNumber: z.number().int().positive().nullable().default(null),
  bpm: z.number().positive().nullable().default(null),
  explicit: z.boolean().nullable().default(null),
  genre: z.string().max(100).nullable().default(null),
  label: z.string().max(300).nullable().default(null),
  sources: z.array(CatalogSource).min(1).max(20),
  /** Higher is a better answer to the query. Ties keep arrival order. */
  rank: z.number().default(0),
});
export type CatalogTrack = z.infer<typeof CatalogTrack>;

export const CatalogArtist = z.object({
  id: z.string().max(260),
  name: z.string().max(300),
  pictureUrl: z.string().max(2048).nullable().default(null),
  albumCount: z.number().int().nonnegative().nullable().default(null),
  fans: z.number().int().nonnegative().nullable().default(null),
  genre: z.string().max(100).nullable().default(null),
  sources: z.array(CatalogSource).min(1).max(20),
  rank: z.number().default(0),
});
export type CatalogArtist = z.infer<typeof CatalogArtist>;

export const CatalogAlbum = z.object({
  id: z.string().max(260),
  title: z.string().max(300),
  artist: z.string().max(300).nullable().default(null),
  artworkUrl: z.string().max(2048).nullable().default(null),
  releaseDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable().default(null),
  year: z.number().int().min(1000).max(3000).nullable().default(null),
  trackCount: z.number().int().nonnegative().nullable().default(null),
  label: z.string().max(300).nullable().default(null),
  genre: z.string().max(100).nullable().default(null),
  explicit: z.boolean().nullable().default(null),
  upc: z.string().max(40).nullable().default(null),
  sources: z.array(CatalogSource).min(1).max(20),
  rank: z.number().default(0),
});
export type CatalogAlbum = z.infer<typeof CatalogAlbum>;

/**
 * A public playlist a search found (UX-CAT-005). Opened, it is a collection like an album: resolve
 * its first source's `url` for its songs (NP-FIND-007). `covers` are the first four songs' artwork
 * when the service gave them cheaply (a listing never costs a call per playlist); else it is empty
 * and `pictureUrl` — the playlist's own picture — stands for it.
 */
export const CatalogPlaylist = z.object({
  id: z.string().max(260),
  title: z.string().max(300),
  owner: z.string().max(300).nullable().default(null),
  trackCount: z.number().int().nonnegative().nullable().default(null),
  pictureUrl: z.string().max(2048).nullable().default(null),
  covers: z.array(z.string().max(2048)).max(4).default([]),
  sources: z.array(CatalogSource).min(1).max(20),
  rank: z.number().default(0),
});
export type CatalogPlaylist = z.infer<typeof CatalogPlaylist>;

/** What a query was read as. A pasted link is resolved, not searched. */
export const CatalogQuery = z.object({
  kind: z.enum(['text', 'advanced', 'isrc', 'url']),
  text: z.string().max(400),
  track: z.string().max(200).nullable().default(null),
  artist: z.string().max(200).nullable().default(null),
  album: z.string().max(200).nullable().default(null),
  isrc: z.string().max(12).nullable().default(null),
  url: z.string().max(2048).nullable().default(null),
});
export type CatalogQuery = z.infer<typeof CatalogQuery>;

/**
 * How one service did (UX-CAT-001). `cooling-down` means it failed recently and is being left alone
 * until `retryAt`; `skipped` means it was not asked (switched off, or it cannot answer this kind of
 * query — MusicBrainz has no artist pictures, yt-dlp no ISRC lookup).
 */
export const CatalogSourceState = z.enum(['pending', 'ok', 'empty', 'failed', 'timeout', 'cooling-down', 'skipped']);
export type CatalogSourceState = z.infer<typeof CatalogSourceState>;

export const CatalogSourceStatus = z.object({
  provider: CatalogProviderId,
  state: CatalogSourceState,
  /** Rows this service returned for this page, before merging. */
  count: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  /** Said in words, for a person. Never a stack trace. */
  error: z.string().max(400).nullable().default(null),
  retryAt: IsoDateTime.nullable().default(null),
});
export type CatalogSourceStatus = z.infer<typeof CatalogSourceStatus>;

export const CatalogPage = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** True when any service returned a full page: asking for the next offset may find more. */
  hasMore: z.boolean(),
});
export type CatalogPage = z.infer<typeof CatalogPage>;

export const CATALOG_MAX_LIMIT = 50;

const csv = <T extends z.ZodEnum>(item: T) =>
  z
    .string()
    .max(200)
    .transform((value, ctx) => {
      const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
      const out: Array<z.infer<T>> = [];
      for (const part of parts) {
        const parsed = item.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom', message: `Unknown value “${part}”` });
          return z.NEVER;
        }
        out.push(parsed.data as z.infer<T>);
      }
      return out;
    });

/**
 * `GET …/catalog/search`. Either `q` (free text, an ISRC or a music link) or any of the advanced
 * fields (`track`, `artist`, `album`), or both. `sections` and `providers` are comma-separated.
 */
export const CatalogSearchRequest = z
  .object({
    q: z.string().trim().max(400).default(''),
    track: z.string().trim().max(200).optional(),
    artist: z.string().trim().max(200).optional(),
    album: z.string().trim().max(200).optional(),
    sections: csv(CatalogSearchSection).optional(),
    providers: csv(CatalogProviderId).optional(),
    offset: z.coerce.number().int().min(0).max(1000).default(0),
    limit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(25),
    /** `0` answers with one aggregate instead of NDJSON. */
    stream: z.enum(['0', '1']).default('1'),
  })
  .refine((r) => Boolean(r.q || r.track || r.artist || r.album), { message: 'Say what to look for: q, or track, artist or album' });
export type CatalogSearchRequest = z.infer<typeof CatalogSearchRequest>;

export const CatalogSearchResultsChunk = z.object({
  type: z.literal('results'),
  seq: z.number().int().nonnegative(),
  /** The service whose answer this chunk carries; null for a merge-only update (cross-links). */
  provider: CatalogProviderId.nullable(),
  query: CatalogQuery,
  tracks: z.array(CatalogTrack),
  artists: z.array(CatalogArtist),
  albums: z.array(CatalogAlbum),
  /** Public playlists (UX-CAT-005); empty from a server that predates them. */
  playlists: z.array(CatalogPlaylist).default([]),
  status: z.array(CatalogSourceStatus),
});
export const CatalogSearchDoneChunk = z.object({
  type: z.literal('done'),
  seq: z.number().int().nonnegative(),
  query: CatalogQuery,
  status: z.array(CatalogSourceStatus),
  page: z.object({ tracks: CatalogPage.nullable(), artists: CatalogPage.nullable(), albums: CatalogPage.nullable(), playlists: CatalogPage.nullable().default(null) }),
  /** Rows after merging, per section. */
  totals: z.object({ tracks: z.number().int().nonnegative(), artists: z.number().int().nonnegative(), albums: z.number().int().nonnegative(), playlists: z.number().int().nonnegative().default(0) }),
  /** A pasted link is not searched: the client should call `resolve` with it. */
  resolve: z.string().max(2048).nullable().default(null),
  /**
   * Platforms on the rows that were not searched but only linked to (Spotify, Tidal, Qobuz, Amazon
   * Music… from MusicBrainz's links, Deezer's ISRC lookup or SongLink with a key): the status line says
   * which platforms were searched (`status`) and which only contributed links (this).
   */
  linkedOnly: z.array(CatalogPlatform).default([]),
});
export const CatalogSearchChunk = z.discriminatedUnion('type', [CatalogSearchResultsChunk, CatalogSearchDoneChunk]);
export type CatalogSearchChunk = z.infer<typeof CatalogSearchChunk>;
export type CatalogSearchResultsChunk = z.infer<typeof CatalogSearchResultsChunk>;
export type CatalogSearchDoneChunk = z.infer<typeof CatalogSearchDoneChunk>;

export const CatalogSearchAggregate = z.object({
  query: CatalogQuery,
  tracks: z.array(CatalogTrack),
  artists: z.array(CatalogArtist),
  albums: z.array(CatalogAlbum),
  playlists: z.array(CatalogPlaylist).default([]),
  status: z.array(CatalogSourceStatus),
  page: CatalogSearchDoneChunk.shape.page,
  resolve: z.string().max(2048).nullable().default(null),
});
export type CatalogSearchAggregate = z.infer<typeof CatalogSearchAggregate>;

/* ---------- details ---------- */

/**
 * What an album or playlist *is*, stably enough to store: the apps keep this when someone stars it
 * into their library, and resolve `url` again to list its songs.
 */
export const CatalogCollectionRef = z.object({
  platform: CatalogPlatform,
  kind: z.enum(['album', 'playlist']),
  id: z.string().min(1).max(260),
  url: z.string().max(2048),
  title: z.string().max(300),
  owner: z.string().max(300).nullable(),
});
export type CatalogCollectionRef = z.infer<typeof CatalogCollectionRef>;


/** One page of an ordered track list (an album's, a playlist's, an artist's top tracks). */
export const CatalogTrackPage = z.object({
  tracks: z.array(CatalogTrack),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** How many the platform says there are, when it says. */
  total: z.number().int().nonnegative().nullable(),
  hasMore: z.boolean(),
  /**
   * True only when a list is longer than `CATALOG_COLLECTION_CAP` (10,000) and the songs past it
   * cannot be opened: said, never a silent cut. Below that every song is reachable page by page.
   */
  capped: z.boolean(),
});
export type CatalogTrackPage = z.infer<typeof CatalogTrackPage>;

/**
 * The most songs one album or playlist opens: every song of any real list, page by page, with a
 * bound so a runaway list cannot hold a server forever. A list past it says so (`capped`).
 */
export const CATALOG_COLLECTION_CAP = 10_000;

/** The most songs one page of a list carries (`limit`). Ask for the next `offset` for more. */
export const CATALOG_PAGE_MAX = 200;

export const CatalogAlbumRequest = z.object({
  /** `platform:id` from a result's source (`deezer:6575789`, `apple-music:617154241`). */
  id: z.string().min(3).max(260),
  offset: z.coerce.number().int().min(0).max(CATALOG_COLLECTION_CAP).default(0),
  limit: z.coerce.number().int().min(1).max(CATALOG_PAGE_MAX).default(100),
});
export const CatalogAlbumDetail = z.object({ album: CatalogAlbum, page: CatalogTrackPage, collection: CatalogCollectionRef });
export type CatalogAlbumDetail = z.infer<typeof CatalogAlbumDetail>;

export const CatalogArtistRequest = z.object({
  id: z.string().min(3).max(260),
  albumsOffset: z.coerce.number().int().min(0).max(500).default(0),
  albumsLimit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(25),
  topLimit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(10),
});
export const CatalogArtistDetail = z.object({
  artist: CatalogArtist,
  topTracks: z.array(CatalogTrack),
  albums: z.array(CatalogAlbum),
  albumsPage: CatalogPage,
});
export type CatalogArtistDetail = z.infer<typeof CatalogArtistDetail>;

/* ---------- collections (albums and playlists, pasted or browsed) ---------- */


/** A starred album or playlist, in the one shape the player, the hub's sync and the companion share. */
export const SavedCollection = z.object({
  ref: CatalogCollectionRef,
  savedAt: IsoDateTime,
  artworkUrl: z.string().max(2048).nullable().default(null),
  /** The first four songs' artwork, in order: the 2×2 mosaic when the list has no cover of its own. */
  covers: z.array(z.string().max(2048)).max(4).default([]),
  trackCount: z.number().int().nonnegative().nullable().default(null),
});
export type SavedCollection = z.infer<typeof SavedCollection>;

/** The caller's starred lists, and (for a device) the hub admin's, read-only, as `shared`. */
export const SavedCollectionList = z.object({ items: z.array(SavedCollection), shared: z.array(SavedCollection).default([]) });
export type SavedCollectionList = z.infer<typeof SavedCollectionList>;

export const CatalogCollection = z.object({
  ref: CatalogCollectionRef,
  /** The list's own cover, when the platform gives it one. */
  artworkUrl: z.string().max(2048).nullable(),
  /** Artwork of the first four songs that have one, in list order, for a 2×2 mosaic. */
  covers: z.array(z.string().max(2048)).max(4),
  releaseDate: CalendarDate.nullable().default(null),
  page: CatalogTrackPage,
});
export type CatalogCollection = z.infer<typeof CatalogCollection>;

/* ---------- resolve ---------- */

export const CatalogResolveRequest = z.object({
  url: z.string().trim().min(1).max(2048),
  offset: z.coerce.number().int().min(0).max(CATALOG_COLLECTION_CAP).default(0),
  limit: z.coerce.number().int().min(1).max(CATALOG_PAGE_MAX).default(100),
});

/**
 * What a pasted link is. `unavailable` and `unsupported` carry `reason` in words: a private or
 * Spotify-made playlist Spotify will not list, a Tidal link with no keyless reader.
 */
export const CatalogResolveResult = z.object({
  url: z.string().max(2048),
  platform: CatalogPlatform.nullable(),
  kind: z.enum(['track', 'album', 'playlist', 'artist', 'unavailable', 'unsupported']),
  track: CatalogTrack.nullable().default(null),
  collection: CatalogCollection.nullable().default(null),
  artist: CatalogArtist.nullable().default(null),
  reason: z.string().max(600).nullable().default(null),
  resolvedAt: IsoDateTime,
});
export type CatalogResolveResult = z.infer<typeof CatalogResolveResult>;

/* ---------- lyrics and enrichment ---------- */

export const CatalogLyricsRequest = z.object({
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  album: z.string().trim().max(300).optional(),
  durationSec: z.coerce.number().int().min(1).max(7200).optional(),
});
export const CatalogLyrics = z.object({
  found: z.boolean(),
  source: z.literal('lrclib'),
  id: z.number().int().nullable().default(null),
  instrumental: z.boolean().default(false),
  /** LRC: `[mm:ss.xx] line`, one per line. */
  synced: z.string().max(100_000).nullable().default(null),
  plain: z.string().max(100_000).nullable().default(null),
  trackName: z.string().max(300).nullable().default(null),
  artistName: z.string().max(300).nullable().default(null),
  durationSec: z.number().nonnegative().nullable().default(null),
});
export type CatalogLyrics = z.infer<typeof CatalogLyrics>;

export const CatalogEnrichRequest = z
  .object({
    isrc: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/[-\s]/g, ''))
      .pipe(z.string().regex(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/))
      .optional(),
    title: z.string().trim().max(300).optional(),
    artist: z.string().trim().max(300).optional(),
    durationSec: z.coerce.number().int().min(1).max(7200).optional(),
    /** Also look for the song on other platforms (MusicBrainz links, Deezer by ISRC, SongLink with a key). */
    links: z.enum(['0', '1']).default('1'),
  })
  .refine((r) => Boolean(r.isrc || (r.title && r.artist)), { message: 'Give an isrc, or a title and an artist' });

/** Genre, label and year from MusicBrainz, and the song's other homes. */
export const CatalogEnrichment = z.object({
  isrc: z.string().max(12).nullable(),
  musicbrainzRecordingId: z.string().max(40).nullable(),
  genre: z.string().max(100).nullable(),
  genres: z.array(z.string().max(100)).max(10),
  label: z.string().max(300).nullable(),
  releaseDate: z.string().max(10).nullable(),
  year: z.number().int().nullable(),
  sources: z.array(CatalogSource),
});
export type CatalogEnrichment = z.infer<typeof CatalogEnrichment>;

/* ---------- hub-only: settings and download ---------- */

export const CatalogSettingsView = z.object({
  /** Write synced or plain lyrics (LRCLIB) into a catalog download's tags. Default on. */
  embedLyrics: z.boolean(),
  providers: z.record(CatalogProviderId, z.boolean()),
  /** SongLink closed keyless access in 2026; with a key it adds Tidal, Qobuz and Amazon links. */
  odesliKeyConfigured: z.boolean(),
});
export type CatalogSettingsView = z.infer<typeof CatalogSettingsView>;
export const CatalogSettingsInput = z.object({
  embedLyrics: z.boolean().optional(),
  providers: z.partialRecord(CatalogProviderId, z.boolean()).optional(),
  /** Write-only. Empty string clears it. */
  odesliKey: z.string().max(200).optional(),
});
export type CatalogSettingsInput = z.infer<typeof CatalogSettingsInput>;

/** The hosts the catalog engine itself calls. Nothing else is reachable from it. */
/** `music.apple.com`: an Apple Music playlist's public page, read for its songs (one GET, no token). */
export const CATALOG_API_HOSTS: readonly string[] = ['itunes.apple.com', 'api.deezer.com', 'musicbrainz.org', 'coverartarchive.org', 'api.song.link', 'lrclib.net', 'music.apple.com'];

/** Where the services keep artwork and clips: what a page loads directly, never fetched by the engine. */
export const CATALOG_MEDIA_HOSTS: readonly string[] = ['*.mzstatic.com', 'audio-ssl.itunes.apple.com', 'cdn-images.dzcdn.net', '*.dzcdn.net', 'i.ytimg.com', '*.sndcdn.com', 'archive.org', '*.archive.org', 'i.scdn.co'];

/** Pages whose links `resolve` reads with the public APIs (the yt-dlp and spotDL hosts are the helper's and the tool preset's). */
export const CATALOG_LINK_HOSTS: readonly string[] = ['music.apple.com', 'itunes.apple.com', 'www.deezer.com', 'deezer.com', 'link.deezer.com', 'deezer.page.link', 'tidal.com', 'listen.tidal.com', 'www.qobuz.com', 'open.qobuz.com', 'play.qobuz.com', 'music.amazon.com', 'www.amazon.com'];

export const HELPER_CATALOG_ROUTES = {
  search: '/helper/v1/catalog/search',
  album: '/helper/v1/catalog/album',
  artist: '/helper/v1/catalog/artist',
  resolve: '/helper/v1/catalog/resolve',
  lyrics: '/helper/v1/catalog/lyrics',
  enrich: '/helper/v1/catalog/enrich',
} as const;

export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';
