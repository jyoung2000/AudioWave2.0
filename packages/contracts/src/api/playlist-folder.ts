/**
 * Playlists kept in a folder (DEC-041): the hub's `<data>/playlists` and the companion's
 * `Music\Airwave Playlists`, each changeable in its app's Settings.
 *
 * A playlist is two files a person can read and move to another player:
 *
 * - `<name>.m3u8` — `#EXTM3U`, `#PLAYLIST:<name>`, then per song `#EXTINF:<secs>,<artist> - <title>`
 *   and its location: a path relative to the folder when the song is in the library, otherwise the
 *   song's best source URL. The M3U is authoritative for which songs are in the list, and in what order.
 * - `<name>.airwave.json` — the sidecar (`PlaylistSidecar`): what M3U cannot carry. A sidecar whose
 *   entries no longer match the M3U (someone edited the list elsewhere) is reconciled by location.
 *
 * A `.m3u`/`.m3u8` dropped into the folder by hand is listed as `origin: 'hand-made'` and
 * `readOnly: true`: Airwave never rewrites it on its own. The first change made to it through Airwave
 * adopts it — its M3U is rewritten and a sidecar written beside it — and from then on it is Airwave's.
 *
 * Served by the hub as `/api/v1/playlists/*` (admin session, or a device with `playlists:use`) and by
 * the companion's main process over `playlists:*` IPC. The engine behind both is
 * `@now-playing/domain/playlist-folder`.
 */
import { z } from 'zod';
import { IsoDateTime } from '../common.js';
import { CatalogPlatform, CatalogSource, CatalogTrack } from './catalog.js';

/** At most this many songs in one playlist. */
export const PLAYLIST_FOLDER_ENTRY_CAP = 10_000;
/** At most this many playlists in one folder; files past it are not read, and the listing says so. */
export const PLAYLIST_FOLDER_PLAYLIST_CAP = 1_000;
/** A page of a playlist's songs. */
export const PLAYLIST_FOLDER_PAGE_MAX = 200;
/** A playlist name, before it is made into a file name. */
export const PLAYLIST_NAME_MAX = 120;
/** At most this many songs added in one request. */
export const PLAYLIST_ADD_MAX = 500;

/** A playlist's id: the sidecar's UUID, or `m-<hash>` for a hand-made file without one. */
export const FolderPlaylistId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export type FolderPlaylistId = z.infer<typeof FolderPlaylistId>;

/** An entry's id inside its playlist: stable while the file is not edited elsewhere. */
export const FolderPlaylistEntryId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export const PlaylistName = z
  .string()
  .trim()
  .min(1, 'A playlist needs a name.')
  .max(PLAYLIST_NAME_MAX)
  // Control characters never reach a file name or the M3U's #PLAYLIST line.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'A name cannot hold control characters.');

/**
 * Where a song plays from: `library` (a file in the library, written as a path relative to the
 * folder), `url` (its best source, when it is not in the library) or `missing` (a path that does not
 * resolve to a file inside the allowed folders, or an entry a hand-made list could not place).
 */
export const FolderPlaylistLocationKind = z.enum(['library', 'url', 'missing']);
export type FolderPlaylistLocationKind = z.infer<typeof FolderPlaylistLocationKind>;

export const FolderPlaylistEntry = z.object({
  id: FolderPlaylistEntryId,
  title: z.string().max(300),
  /** The credited artist line. */
  artist: z.string().max(300),
  artists: z.array(z.string().max(300)).max(20).default([]),
  album: z.string().max(300).nullable().default(null),
  durationSec: z.number().int().nonnegative().nullable().default(null),
  /** What the M3U holds for it: a relative path or a URL. Never an absolute path. */
  location: z.string().max(4096).nullable(),
  locationKind: FolderPlaylistLocationKind,
  /** The library's id for the file, when the location is one: what a player streams. */
  trackId: z.string().max(80).nullable().default(null),
  /** The catalog's `platform:id` for the song, when it came from search. */
  catalogId: z.string().max(260).nullable().default(null),
  isrc: z.string().max(20).nullable().default(null),
  artworkUrl: z.string().max(2048).nullable().default(null),
  platforms: z.array(CatalogPlatform).max(11).default([]),
  sources: z.array(CatalogSource).max(20).default([]),
  addedAt: IsoDateTime.nullable().default(null),
  /** Who added it: `admin`, a device id, or `companion`. Null in a hand-made list. */
  addedBy: z.string().max(80).nullable().default(null),
});
export type FolderPlaylistEntry = z.infer<typeof FolderPlaylistEntry>;

export const FolderPlaylistSummary = z.object({
  id: FolderPlaylistId,
  name: z.string().max(PLAYLIST_NAME_MAX * 2),
  /** The M3U's file name inside the folder (never a path). */
  fileName: z.string().max(260),
  description: z.string().max(2000).nullable().default(null),
  createdAt: IsoDateTime.nullable().default(null),
  updatedAt: IsoDateTime,
  entryCount: z.number().int().nonnegative(),
  durationSec: z.number().int().nonnegative(),
  /** The first four songs' artwork, in order: the 2×2 mosaic. */
  covers: z.array(z.string().max(2048)).max(4).default([]),
  origin: z.enum(['airwave', 'hand-made']),
  /** A hand-made list: Airwave shows it and leaves it alone until it is changed here. */
  readOnly: z.boolean(),
  /** Who made it (`admin`, a device id, `companion`); null for a hand-made list. */
  createdBy: z.string().max(80).nullable().default(null),
  /** Asked with a song (`catalogId`/`isrc`): whether that song is in it already. Null when not asked. */
  hasTrack: z.boolean().nullable().default(null),
});
export type FolderPlaylistSummary = z.infer<typeof FolderPlaylistSummary>;

export const PlaylistFolderInfo = z.object({
  /** How the folder is shown: on the hub, inside the data volume (`/data/playlists`); on the companion, the folder itself. */
  path: z.string().max(4096),
  /** On the hub, the folder relative to the data volume (`playlists`); null on the companion. */
  relativePath: z.string().max(500).nullable().default(null),
  isDefault: z.boolean(),
  /** False when the folder cannot be read or written; `reason` says why. */
  available: z.boolean(),
  reason: z.string().max(600).nullable().default(null),
  playlistCount: z.number().int().nonnegative(),
  /** More playlist files than `PLAYLIST_FOLDER_PLAYLIST_CAP`: the rest are not read. */
  capped: z.boolean().default(false),
});
export type PlaylistFolderInfo = z.infer<typeof PlaylistFolderInfo>;

export const FolderPlaylistList = z.object({ folder: PlaylistFolderInfo, items: z.array(FolderPlaylistSummary) });
export type FolderPlaylistList = z.infer<typeof FolderPlaylistList>;

export const FolderPlaylistPage = z.object({
  playlist: FolderPlaylistSummary,
  items: z.array(FolderPlaylistEntry),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type FolderPlaylistPage = z.infer<typeof FolderPlaylistPage>;

/** Which song to look for when listing (ticks in Add to Playlist ▸). */
export const FolderPlaylistListQuery = z.object({
  catalogId: z.string().max(260).optional(),
  isrc: z.string().max(20).optional(),
});

export const FolderPlaylistPageQuery = z.object({
  offset: z.coerce.number().int().min(0).max(PLAYLIST_FOLDER_ENTRY_CAP).default(0),
  limit: z.coerce.number().int().min(1).max(PLAYLIST_FOLDER_PAGE_MAX).default(100),
});

export const FolderPlaylistCreate = z.object({
  name: PlaylistName,
  description: z.string().max(2000).nullable().optional(),
  /** Songs to start it with (from search). */
  tracks: z.array(CatalogTrack).max(PLAYLIST_ADD_MAX).default([]),
});
export type FolderPlaylistCreate = z.infer<typeof FolderPlaylistCreate>;

export const FolderPlaylistUpdate = z
  .object({ name: PlaylistName.optional(), description: z.string().max(2000).nullable().optional() })
  .refine((v) => v.name !== undefined || v.description !== undefined, 'Nothing to change.');
export type FolderPlaylistUpdate = z.infer<typeof FolderPlaylistUpdate>;

export const FolderPlaylistAdd = z.object({
  tracks: z.array(CatalogTrack).min(1).max(PLAYLIST_ADD_MAX),
  /** Where to put them (0 = first); at the end when absent. */
  position: z.number().int().min(0).max(PLAYLIST_FOLDER_ENTRY_CAP).optional(),
  /** Add a song even when it is in the list already. Off: a song already there is skipped. */
  allowDuplicates: z.boolean().default(false),
});
export type FolderPlaylistAdd = z.infer<typeof FolderPlaylistAdd>;

export const FolderPlaylistAddResult = z.object({ playlist: FolderPlaylistSummary, added: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() });
export type FolderPlaylistAddResult = z.infer<typeof FolderPlaylistAddResult>;

export const FolderPlaylistRemove = z.object({ entryIds: z.array(FolderPlaylistEntryId).min(1).max(PLAYLIST_ADD_MAX) });
export type FolderPlaylistRemove = z.infer<typeof FolderPlaylistRemove>;

/** Move one entry to a new index (drag, or Alt+↑/↓). */
export const FolderPlaylistMove = z.object({ entryId: FolderPlaylistEntryId, to: z.number().int().min(0).max(PLAYLIST_FOLDER_ENTRY_CAP) });
export type FolderPlaylistMove = z.infer<typeof FolderPlaylistMove>;

/** The hub's folder, changed: a path inside the data volume, and whether to move the playlists already kept. */
export const PlaylistFolderChange = z.object({
  relativePath: z.string().trim().min(1).max(500),
  move: z.boolean().default(true),
});
export type PlaylistFolderChange = z.infer<typeof PlaylistFolderChange>;

export const PlaylistFolderChangeResult = z.object({ folder: PlaylistFolderInfo, moved: z.number().int().nonnegative(), failed: z.array(z.string().max(300)).max(50).default([]) });
export type PlaylistFolderChangeResult = z.infer<typeof PlaylistFolderChangeResult>;

/* ------------------------------------------------------------------ the sidecar file */

export const PLAYLIST_SIDECAR_FORMAT = 'airwave-playlist';
export const PLAYLIST_SIDECAR_SUFFIX = '.airwave.json';

export const PlaylistSidecarEntry = z.object({
  id: FolderPlaylistEntryId,
  /** The M3U line it belongs to: how a sidecar is matched back to a list edited elsewhere. */
  location: z.string().max(4096).nullable(),
  title: z.string().max(300),
  artist: z.string().max(300),
  artists: z.array(z.string().max(300)).max(20).default([]),
  album: z.string().max(300).nullable().default(null),
  durationSec: z.number().int().nonnegative().nullable().default(null),
  catalogId: z.string().max(260).nullable().default(null),
  isrc: z.string().max(20).nullable().default(null),
  artworkUrl: z.string().max(2048).nullable().default(null),
  platforms: z.array(CatalogPlatform).max(11).default([]),
  sources: z.array(CatalogSource).max(20).default([]),
  addedAt: IsoDateTime.nullable().default(null),
  addedBy: z.string().max(80).nullable().default(null),
});
export type PlaylistSidecarEntry = z.infer<typeof PlaylistSidecarEntry>;

export const PlaylistSidecar = z.object({
  format: z.literal(PLAYLIST_SIDECAR_FORMAT),
  version: z.literal(1),
  id: FolderPlaylistId,
  name: z.string().max(PLAYLIST_NAME_MAX * 2),
  description: z.string().max(2000).nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: z.string().max(80).nullable().default(null),
  /** The 2×2 mosaic: the first four songs' artwork. */
  covers: z.array(z.string().max(2048)).max(4).default([]),
  entries: z.array(PlaylistSidecarEntry).max(PLAYLIST_FOLDER_ENTRY_CAP),
});
export type PlaylistSidecar = z.infer<typeof PlaylistSidecar>;
