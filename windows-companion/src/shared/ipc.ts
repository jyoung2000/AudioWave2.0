/**
 * The IPC contract between the renderer and the main process.
 *
 * This file is the security boundary written down. The renderer has no Node access, no remote
 * module and no direct filesystem: everything it can do is one of the channels below, each with a
 * validated request and a validated response. Adding a capability means adding a channel here and
 * implementing it in the main process — there is no ambient way to reach the operating system.
 *
 * Absolute paths appear in *this* process pair and nowhere else. Nothing here is ever synced to a
 * hub, and the shared library metadata carries a root id and a relative path instead
 * (docs/PRIVACY.md).
 */
import { z } from 'zod';
import {
  CATALOG_COLLECTION_CAP,
  CATALOG_MAX_LIMIT,
  CATALOG_PAGE_MAX,
  CatalogAlbumDetail,
  CatalogArtistDetail,
  CatalogCollectionRef,
  CatalogEnrichment,
  CatalogLyrics,
  CatalogProviderId,
  CatalogResolveResult,
  CatalogSearchChunk,
  CatalogSearchSection,
  CatalogSource,
  CatalogTrack,
  DownloadAuthorizationBasis,
  EqPreset,
  HelperJob,
  OutputFormat,
  Playlist,
  SavedCollection,
  Track,
} from '@now-playing/contracts';
import { IPC_CHANNELS, IPC_EVENT_NAMES, type IpcChannel, type IpcEvent } from './channels.js';

/* ------------------------------------------------------------------ library */

/** What a folder holds. Music is indexed; TV and movies are kept, watched and backed up, not indexed. */
export const FolderKind = z.enum(['music', 'tv', 'movies']);
export type FolderKind = z.infer<typeof FolderKind>;

export const LibraryFolder = z.object({
  id: z.uuid(),
  path: z.string().min(1),
  displayName: z.string().min(1).max(200),
  watch: z.boolean().default(true),
  kind: FolderKind.default('music'),
  trackCount: z.number().int().nonnegative().default(0),
  sizeBytes: z.number().int().nonnegative().default(0),
  lastScanAt: z.iso.datetime({ offset: true }).nullable().default(null),
  lastScanError: z.string().nullable().default(null),
  /** False when the folder has been unplugged, renamed or is on a disconnected network share. */
  available: z.boolean().default(true),
});
export type LibraryFolder = z.infer<typeof LibraryFolder>;

export const ScanProgress = z.object({
  folderId: z.uuid(),
  found: z.number().int(),
  indexed: z.number().int(),
  skipped: z.number().int(),
  /** The file being read, shown as progress. Never persisted or sent anywhere. */
  currentName: z.string().nullable(),
  done: z.boolean(),
  error: z.string().nullable(),
});
export type ScanProgress = z.infer<typeof ScanProgress>;

/* --------------------------------------------------------------- hub pairing */

export const HubConnection = z.object({
  endpoint: z.string().url().nullable(),
  hubId: z.uuid().nullable(),
  hubName: z.string().nullable(),
  hubFingerprint: z.string().nullable(),
  connected: z.boolean(),
  /** Why the hub is unusable, in a sentence. Null when it is fine. */
  reason: z.string().nullable(),
  scopes: z.array(z.string()),
  lastSyncAt: z.iso.datetime({ offset: true }).nullable(),
});
export type HubConnection = z.infer<typeof HubConnection>;

/** A paired hub's group a song from Search can join (UX-SEARCH-012): its id and its name, nothing else. */
export const HubGroupChoice = z.object({ id: z.uuid(), name: z.string().min(1).max(80) });
export type HubGroupChoice = z.infer<typeof HubGroupChoice>;

/** What the hub said to a request: queued (and where), or why not, in its own words. */
export const GroupRequestAnswer = z.object({
  queued: z.boolean(),
  title: z.string().max(300).nullable(),
  position: z.number().int().positive().nullable(),
  reason: z.string().max(600).nullable(),
});
export type GroupRequestAnswer = z.infer<typeof GroupRequestAnswer>;

export const PairingChallenge = z.object({
  sessionId: z.uuid(),
  verificationFingerprint: z.string(),
  hubFingerprint: z.string(),
  hubName: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type PairingChallenge = z.infer<typeof PairingChallenge>;

/* ------------------------------------------------------------------ transfers */

export const TransferProgress = z.object({
  id: z.string(),
  kind: z.enum(['upload', 'download']),
  trackTitle: z.string(),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  state: z.enum(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  error: z.string().nullable(),
});
export type TransferProgress = z.infer<typeof TransferProgress>;

/* --------------------------------------------------------------------- backup */

export const BackupSummary = z.object({
  path: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  sizeBytes: z.number().int(),
  contents: z.object({ tracks: z.number().int(), playlists: z.number().int(), presets: z.number().int(), events: z.number().int() }),
});
export type BackupSummary = z.infer<typeof BackupSummary>;

/** What a backup can hold. `algorithms` is the paired hub's recommendation settings, read when it allows. */
export const BackupPartName = z.enum(['music', 'tv', 'movies', 'playlists', 'presets', 'algorithms', 'settings']);
export type BackupPartName = z.infer<typeof BackupPartName>;

export const BackupSettings = z.object({
  /** Where archives go. Null until chosen: nothing is backed up to a guessed place. */
  dir: z.string().nullable().default(null),
  include: z
    .object({
      music: z.boolean().default(true),
      tv: z.boolean().default(false),
      movies: z.boolean().default(false),
      playlists: z.boolean().default(true),
      presets: z.boolean().default(true),
      algorithms: z.boolean().default(true),
      settings: z.boolean().default(true),
    })
    .default({ music: true, tv: false, movies: false, playlists: true, presets: true, algorithms: true, settings: true }),
  schedule: z.enum(['manual', 'daily', 'weekly']).default('manual'),
  /** How many archives to keep; 0 keeps every one. */
  keep: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(10)]).default(5),
  lastRunAt: z.iso.datetime({ offset: true }).nullable().default(null),
  lastRunError: z.string().nullable().default(null),
});
export type BackupSettings = z.infer<typeof BackupSettings>;

/** Written out like `PreferencesPatch`, for the same reason: a partial must not reset the rest. */
export const BackupSettingsPatch = z.strictObject({
  include: z
    .strictObject({
      music: z.boolean().optional(),
      tv: z.boolean().optional(),
      movies: z.boolean().optional(),
      playlists: z.boolean().optional(),
      presets: z.boolean().optional(),
      algorithms: z.boolean().optional(),
      settings: z.boolean().optional(),
    })
    .optional(),
  schedule: z.enum(['manual', 'daily', 'weekly']).optional(),
  keep: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(10)]).optional(),
});
export type BackupSettingsPatch = z.infer<typeof BackupSettingsPatch>;

const Measure = z.object({ bytes: z.number().int().nonnegative(), files: z.number().int().nonnegative(), measuredAt: z.iso.datetime({ offset: true }) });

/**
 * How big the next backup would be and how much room it has. The folder figures come from the same
 * measurement the helper's `/helper/v1/backup/estimate` route serves, so the player's Backup pane
 * and this window can never disagree about the same folder.
 */
export const BackupEstimate = z.object({
  parts: z.object({ music: Measure.optional(), tv: Measure.optional(), movies: Measure.optional() }),
  /** Playlists, presets and settings as they would be written: a measured size, not a guess. */
  dataBytes: z.number().int().nonnegative(),
  expectedBytes: z.number().int().nonnegative(),
  /** Null when a part that is included could not be measured: then the total is unknown, not smaller. */
  complete: z.boolean(),
  destination: z.object({ path: z.string(), freeBytes: z.number().int().nullable(), totalBytes: z.number().int().nullable() }).nullable(),
  /** Why Back Up Now is disabled, in a sentence; null when it can run. */
  blocked: z.string().nullable(),
});
export type BackupEstimate = z.infer<typeof BackupEstimate>;

export const BackupArchive = z.object({
  id: z.string(),
  path: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  sizeBytes: z.number().int().nonnegative(),
  parts: z.array(BackupPartName),
  contents: BackupSummary.shape.contents,
  /** False for an archive whose manifest is missing or unreadable: listed, but not restorable. */
  restorable: z.boolean(),
});
export type BackupArchive = z.infer<typeof BackupArchive>;

export const BackupProgress = z.object({
  phase: z.enum(['measuring', 'copying', 'writing', 'pruning', 'done', 'failed']),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  /** The file being copied, shown as progress. Never persisted or sent anywhere. */
  currentName: z.string().nullable(),
  error: z.string().nullable(),
});
export type BackupProgress = z.infer<typeof BackupProgress>;

/**
 * Whether the paired hub's recommendation settings can go into a backup now, and if not, why — in
 * the sentence the Backup pane shows under the checkbox.
 */
export const BackupAlgorithms = z.object({
  available: z.boolean(),
  hubName: z.string().nullable(),
  reason: z.string().nullable(),
});
export type BackupAlgorithms = z.infer<typeof BackupAlgorithms>;

/* ---------------------------------------------------------------------- awsp */

export const AwspTier = z.enum(['lossless', 'high', 'saver']);
export type AwspTier = z.infer<typeof AwspTier>;

/** A device paired to stream from this PC (docs/AWSP.md §1–2). Kept under DPAPI by the main process. */
export const AwspDevice = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  clientKind: z.enum(['pwa', 'android']),
  tierCap: AwspTier,
  pairedAt: z.iso.datetime({ offset: true }),
  /** When it last connected or was last connected; null until it first connects. */
  lastSeenAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type AwspDevice = z.infer<typeof AwspDevice>;

/**
 * What kind of connection this PC is on, as Windows rates its cost: `metered` for mobile data, a
 * hotspot or a connection marked metered; `offline` with none; `unknown` when it could not be told.
 */
export const NetworkKind = z.enum(['unmetered', 'metered', 'offline', 'unknown']);
export type NetworkKind = z.infer<typeof NetworkKind>;

/** Which connections streaming may use, what this PC is on now, and why streaming is paused if it is. */
export const AwspNetwork = z.object({
  unmetered: z.boolean(),
  metered: z.boolean(),
  connection: NetworkKind,
  /** Why streaming is paused on this connection, in a sentence; null when it is not. */
  blocked: z.string().nullable(),
});
export type AwspNetwork = z.infer<typeof AwspNetwork>;

export const AwspStatus = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  /** Why it is not running, or what went wrong, in a sentence. */
  reason: z.string().nullable(),
  endpointId: z.string().nullable(),
  ticket: z.string().nullable(),
  /** The ticket as a QR code, drawn by the main process (SVG markup). */
  ticketQrSvg: z.string().nullable(),
  relayUrl: z.string().nullable(),
  pairingCode: z.object({ code: z.string(), expiresAt: z.string() }).nullable(),
  devices: z.array(AwspDevice),
  connections: z.array(z.object({ peer: z.string(), name: z.string().nullable(), type: z.enum(['direct', 'relay', 'bridge']), rttMs: z.number().nullable() })),
  port: z.number().int().nullable(),
  network: AwspNetwork.default({ unmetered: true, metered: true, connection: 'unknown', blocked: null }),
});
export type AwspStatus = z.infer<typeof AwspStatus>;

/* -------------------------------------------------------------------- helper */

/**
 * Automatic setup's progress for one tool (UX-SETUP-001): ready, installing with a 0–1 progress,
 * failed with the reason, or unsupported on this PC with what to do instead.
 */
export const HelperToolSetup = z.object({
  state: z.enum(['ready', 'installing', 'failed', 'unsupported']),
  progress: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});
export type HelperToolSetup = z.infer<typeof HelperToolSetup>;

export const HelperTool = z.object({
  id: z.enum(['yt-dlp', 'spotdl', 'ffmpeg']),
  present: z.boolean(),
  version: z.string().nullable(),
  /** Where it was found, for the person to check; null when absent. */
  path: z.string().nullable(),
  /** What to do about it, when absent and it cannot be set up automatically. */
  advice: z.string().nullable(),
  /** How it was found: `installed` means the companion set it up itself. */
  origin: z.enum(['path', 'installed', 'configured', 'missing']).optional(),
  /** Automatic setup's state; absent until setup has looked at the tool. */
  setup: HelperToolSetup.nullable().optional(),
  /** What the last Check found: the newest release and whether this copy is behind it. Absent until checked. */
  latest: z
    .object({
      version: z.string().nullable(),
      /** True behind, false current, null when it could not be told (then `reason` says why). */
      updateAvailable: z.boolean().nullable(),
      reason: z.string().nullable(),
      checkedAt: z.iso.datetime({ offset: true }),
    })
    .nullable()
    .optional(),
  /** A Check is asking GitHub right now. */
  checking: z.boolean().optional(),
});
export type HelperTool = z.infer<typeof HelperTool>;

/** The embedded local helper: the same program `local-helper/` ships on its own, run inside this app. */
export const HelperStatus = z.object({
  running: z.boolean(),
  port: z.number().int().nullable(),
  origin: z.string().nullable(),
  /** Why it is not running, in a sentence. */
  reason: z.string().nullable(),
  tools: z.array(HelperTool),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Downloads are running or waiting: a tool in use cannot be replaced until they finish. */
  busy: z.boolean().default(false),
  /** Also answering other devices on this network (Settings ▸ Network). */
  lan: z.boolean().default(false),
});
export type HelperStatus = z.infer<typeof HelperStatus>;

/* ------------------------------------------------------------------- live tv */

/** A channel playlist (M3U) or a programme guide (XMLTV). */
export const TvLinkKind = z.enum(['m3u', 'epg']);
export type TvLinkKind = z.infer<typeof TvLinkKind>;

/**
 * A link kept in the Live TV tab. It is only ever kept after the main process has read it and found
 * what it claims to hold; `failed` means it held that once and did not answer the last time it was
 * looked at, and what it last held is still served.
 */
export const TvLink = z.object({
  id: z.string().min(1).max(80),
  kind: TvLinkKind,
  url: z.string().min(1).max(2048),
  state: z.enum(['ok', 'failed', 'checking']),
  /** A few words for the row: “112 channels”, “7-day guide”, or what is wrong (“unreachable”). */
  summary: z.string().nullable(),
  /** Why the last look failed, in a sentence; null when it did not. */
  error: z.string().nullable(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TvLink = z.infer<typeof TvLink>;

export const TvLinks = z.object({ m3u: z.array(TvLink), epg: z.array(TvLink) });
export type TvLinks = z.infer<typeof TvLinks>;

/* -------------------------------------------------------------------- system */

export const AppInfo = z.object({
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  contractsVersion: z.string(),
  protocolVersion: z.number().int(),
  dataDir: z.string(),
  /** Whether this build was signed in CI. Unsigned builds say so rather than implying otherwise. */
  signed: z.boolean(),
  updateFeedUrl: z.string().nullable(),
  /** Where the companion writes its logs. */
  logsDir: z.string().default(''),
});
export type AppInfo = z.infer<typeof AppInfo>;

/** What happens when a download finishes, besides it being saved. */
export const DownloadDone = z.enum(['nothing', 'notify', 'reveal']);
export type DownloadDone = z.infer<typeof DownloadDone>;

export const Preferences = z.object({
  launchAtLogin: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  watchFolders: z.boolean().default(true),
  autoSync: z.boolean().default(false),
  theme: z.enum(['system', 'light']).default('system'),
  /** The port the embedded helper listens on; the player scans 17342–17345. */
  helperPort: z.number().int().min(1024).max(65535).default(17342),
  /** Let setup update yt-dlp by itself once a day. Off: only Update in Settings does. */
  autoUpdateTools: z.boolean().default(true),
  /** Ask GitHub once a day whether there is a newer companion. */
  checkForUpdates: z.boolean().default(true),
  /** Where finished downloads are saved. Null: the Downloads folder inside Music. Set only through the folder picker. */
  downloadDir: z.string().nullable().default(null),
  /** The format a download is saved in when the player does not name one. */
  downloadFormat: OutputFormat.default('original'),
  /** How many downloads run at once. */
  downloadConcurrency: z.number().int().min(1).max(4).default(2),
  /** A speed limit for each download, in KB/s; null for none. */
  downloadRateKBps: z.number().int().min(1).max(1_000_000).nullable().default(null),
  downloadDone: DownloadDone.default('nothing'),
  /** Let other devices on this network use the helper's token-free read routes without pairing. */
  helperLan: z.boolean().default(false),
  /** Write debug lines to the log as well. */
  verboseLogs: z.boolean().default(false),
});
export type Preferences = z.infer<typeof Preferences>;

/**
 * A change to some preferences. Written out rather than `Preferences.partial()`: Zod 4 fills in
 * `.default()` values even inside optional fields, so a partial of `Preferences` would reset every
 * preference the renderer did not mention. `strict` refuses an unknown key rather than silently
 * ignoring it, which is what keeps a renderer from introducing a preference the main process never
 * agreed to — a filesystem path among them.
 */
export const PreferencesPatch = z.strictObject({
  launchAtLogin: z.boolean().optional(),
  minimizeToTray: z.boolean().optional(),
  watchFolders: z.boolean().optional(),
  autoSync: z.boolean().optional(),
  theme: z.enum(['system', 'light']).optional(),
  helperPort: z.number().int().min(1024).max(65535).optional(),
  autoUpdateTools: z.boolean().optional(),
  checkForUpdates: z.boolean().optional(),
  // No downloadDir: a folder is only ever chosen in the system's own picker (downloads:pick-dir).
  downloadFormat: OutputFormat.optional(),
  downloadConcurrency: z.number().int().min(1).max(4).optional(),
  downloadRateKBps: z.number().int().min(1).max(1_000_000).nullable().optional(),
  downloadDone: DownloadDone.optional(),
  helperLan: z.boolean().optional(),
  verboseLogs: z.boolean().optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

/** Whether a newer companion is out, from the project's GitHub releases. */
export const AppUpdate = z.object({
  current: z.string(),
  /** The newest release's version; null until asked, or when it could not be read. */
  latest: z.string().nullable(),
  available: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Why the last check did not get an answer, in a sentence. */
  reason: z.string().nullable(),
  enabled: z.boolean(),
});
export type AppUpdate = z.infer<typeof AppUpdate>;

/** What the companion keeps that it can fetch again, and where its logs are. */
export const StorageReport = z.object({
  cache: z.object({ app: z.number().int().nonnegative(), liveTv: z.number().int().nonnegative(), downloads: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  logsDir: z.string(),
});
export type StorageReport = z.infer<typeof StorageReport>;

const ToolId = z.enum(['yt-dlp', 'spotdl', 'ffmpeg']);

/* ------------------------------------------------------------------- catalog */

/**
 * The music catalog (DEC-039), asked of the embedded helper's `/helper/v1/catalog/*` by the main
 * process: the renderer's content security policy keeps it to this app, and the helper's token stays
 * in the main process. A search answers at once; its chunks arrive as `event:catalog-chunk`, tagged
 * with the `searchId` the window chose, until the `done` chunk. Every other read answers with its
 * result, or null and the reason in words.
 */
export const CatalogSearchId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);

export const CatalogSearchIpc = z.strictObject({
  searchId: CatalogSearchId,
  q: z.string().max(400).default(''),
  track: z.string().max(200).optional(),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
  sections: z.array(CatalogSearchSection).min(1).max(4),
  providers: z.array(CatalogProviderId).min(1).max(5),
  offset: z.number().int().min(0).max(1000).default(0),
  limit: z.number().int().min(1).max(CATALOG_MAX_LIMIT).default(25),
});
export type CatalogSearchIpc = z.infer<typeof CatalogSearchIpc>;

/** Which sections the Search tool shows (Songs, Artists, Albums and Playlists, UX-SEARCH-010) and which services it asks, kept on this PC. */
export const CatalogFilter = z.object({ sections: z.array(CatalogSearchSection).min(1).max(4), providers: z.array(CatalogProviderId).min(1).max(5) });
export type CatalogFilter = z.infer<typeof CatalogFilter>;

const Answer = <T extends z.ZodType>(result: T) => z.object({ result: result.nullable(), reason: z.string().max(600).nullable() });
const ListPage = { offset: z.number().int().min(0).max(CATALOG_COLLECTION_CAP).default(0), limit: z.number().int().min(1).max(CATALOG_PAGE_MAX).default(50) };
const SavedList = z.object({ items: z.array(SavedCollection) });

/**
 * Every channel, with the shape of its request and its result.
 *
 * A channel not listed here does not exist: the preload script exposes exactly these names, and the
 * main process refuses anything else.
 */
export const IPC = {
  'app:info': { request: z.void(), response: AppInfo },
  'app:preferences:get': { request: z.void(), response: Preferences },
  'app:preferences:set': { request: PreferencesPatch, response: Preferences },
  /** Every preference back to how a fresh install has it. Folders, links and pairings are not preferences. */
  'app:preferences:reset': { request: z.void(), response: Preferences },
  'app:open-external': { request: z.object({ url: z.string().url() }), response: z.object({ opened: z.boolean(), reason: z.string().nullable() }) },
  'app:reveal': { request: z.object({ trackId: z.uuid() }), response: z.object({ ok: z.boolean(), reason: z.string().nullable() }) },
  /** Opens the folder the companion keeps its own data in. Takes no path: the renderer cannot name one. */
  'app:open-data-folder': { request: z.void(), response: z.object({ ok: z.boolean(), reason: z.string().nullable() }) },
  'app:update-status': { request: z.void(), response: AppUpdate },
  /** Asks GitHub now, whatever the daily schedule says. */
  'app:check-update': { request: z.void(), response: AppUpdate },
  /** Opens the project's release page. Takes no URL: the main process opens only that one GitHub page. */
  'app:open-release': { request: z.void(), response: z.object({ opened: z.boolean(), reason: z.string().nullable() }) },
  'app:storage': { request: z.void(), response: StorageReport },
  /** Empties the caches the storage report counts. Nothing that cannot be fetched again is touched. */
  'app:clear-cache': { request: z.void(), response: z.object({ storage: StorageReport, reason: z.string().nullable() }) },
  /** Opens the companion's own logs folder. Takes no path. */
  'app:open-logs': { request: z.void(), response: z.object({ ok: z.boolean(), reason: z.string().nullable() }) },
  /** Asks where to save, then writes a .zip of the logs with tokens, secrets and folder paths taken out. */
  'app:export-logs': { request: z.void(), response: z.object({ path: z.string().nullable(), reason: z.string().nullable() }) },
  /** The system's folder picker for where downloads are saved. The only way that preference changes. */
  'downloads:pick-dir': { request: z.void(), response: z.object({ preferences: Preferences, reason: z.string().nullable() }) },

  'library:folders': { request: z.void(), response: z.object({ items: z.array(LibraryFolder) }) },
  'library:add-folder': { request: z.object({ kind: FolderKind.default('music') }).default({ kind: 'music' }), response: z.object({ folder: LibraryFolder.nullable(), reason: z.string().nullable() }) },
  'library:remove-folder': { request: z.object({ folderId: z.uuid() }), response: z.object({ ok: z.boolean() }) },
  'library:scan': { request: z.object({ folderId: z.uuid().optional() }), response: z.object({ started: z.boolean(), reason: z.string().nullable() }) },
  'library:tracks': { request: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).default(200), offset: z.number().int().nonnegative().default(0) }), response: z.object({ items: z.array(Track), total: z.number().int() }) },
  /** The ids alone, in the list's order: what choosing a range or everything needs without loading every song. */
  'library:track-ids': { request: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100_000).default(100_000), offset: z.number().int().nonnegative().default(0) }), response: z.object({ ids: z.array(z.string()), total: z.number().int() }) },
  'library:playlists': { request: z.void(), response: z.object({ items: z.array(Playlist) }) },
  'library:presets': { request: z.void(), response: z.object({ items: z.array(EqPreset) }) },

  'hub:status': { request: z.void(), response: HubConnection },
  'hub:pair-start': { request: z.object({ endpoint: z.string().min(1).max(500), code: z.string().min(4).max(32) }), response: z.object({ challenge: PairingChallenge.nullable(), reason: z.string().nullable() }) },
  'hub:pair-await': { request: z.object({ sessionId: z.uuid() }), response: z.object({ connection: HubConnection, reason: z.string().nullable() }) },
  'hub:forget': { request: z.void(), response: HubConnection },
  'hub:sync-now': { request: z.void(), response: z.object({ started: z.boolean(), reason: z.string().nullable() }) },
  'hub:share-library': { request: z.object({ enabled: z.boolean() }), response: z.object({ enabled: z.boolean(), reason: z.string().nullable() }) },
  /** Whether sharing is on, so the checkbox shows what was chosen rather than starting off every time. */
  'hub:sharing': { request: z.void(), response: z.object({ enabled: z.boolean() }) },
  /**
   * Up Next from Search (UX-SEARCH-012): the companion has no queue of its own, so a song goes to a
   * paired hub's group. The groups this companion is in (active ones), or the reason there are none
   * to offer — no hub paired, no permission to join groups, the hub out of reach — in a sentence.
   */
  'hub:groups': { request: z.void(), response: z.object({ items: z.array(HubGroupChoice).max(200), reason: z.string().max(600).nullable() }) },
  /** A song into a group's queue the way a Discord /play is (`POST /groups/:id/requests`): its link, or "Artist - Title". */
  'hub:request': { request: z.strictObject({ groupId: z.uuid(), query: z.string().trim().min(1).max(300) }), response: GroupRequestAnswer },

  'transfers:list': { request: z.void(), response: z.object({ items: z.array(TransferProgress) }) },
  'transfers:send': { request: z.object({ trackIds: z.array(z.uuid()).min(1).max(500) }), response: z.object({ queued: z.number().int(), reason: z.string().nullable() }) },
  'transfers:cancel': { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },

  'backup:settings:get': { request: z.void(), response: BackupSettings },
  'backup:settings:set': { request: BackupSettingsPatch, response: BackupSettings },
  'backup:pick-dir': { request: z.void(), response: z.object({ settings: BackupSettings, reason: z.string().nullable() }) },
  'backup:estimate': { request: z.void(), response: BackupEstimate },
  'backup:list': { request: z.void(), response: z.object({ items: z.array(BackupArchive) }) },
  /** Writes an archive into the backup folder. Without one, or without room, it says why instead. */
  'backup:create': { request: z.void(), response: z.object({ backup: BackupSummary.nullable(), reason: z.string().nullable() }) },
  /** With an id, restores that archive; without one, asks for a file (an export from any companion). */
  'backup:restore': { request: z.object({ id: z.string().optional() }).default({}), response: z.object({ restored: z.boolean(), reason: z.string().nullable(), summary: BackupSummary.nullable() }) },
  'backup:remove': { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean(), reason: z.string().nullable() }) },
  'backup:export-playlists': { request: z.void(), response: z.object({ path: z.string().nullable(), count: z.number().int(), reason: z.string().nullable() }) },
  /** Whether the paired hub's recommendation settings can be backed up now, and why not when they cannot. */
  'backup:algorithms': { request: z.void(), response: BackupAlgorithms },

  'awsp:status': { request: z.void(), response: AwspStatus },
  'awsp:set-enabled': { request: z.object({ enabled: z.boolean() }), response: AwspStatus },
  'awsp:set-port': { request: z.object({ port: z.number().int().min(1024).max(65535).nullable() }), response: AwspStatus },
  'awsp:new-code': { request: z.void(), response: AwspStatus },
  'awsp:revoke': { request: z.object({ id: z.string().min(1).max(200) }), response: AwspStatus },
  'awsp:set-tier': { request: z.object({ id: z.string().min(1).max(200), tier: AwspTier }), response: AwspStatus },
  /** Which connections streaming may use: Wi-Fi and Ethernet, metered ones (mobile data, hotspots), or both. */
  'awsp:set-networks': { request: z.strictObject({ unmetered: z.boolean().optional(), metered: z.boolean().optional() }), response: AwspStatus },

  'helper:status': { request: z.void(), response: HelperStatus },
  'helper:check-tools': { request: z.void(), response: HelperStatus },
  /** "Try Again": set up every tool that is missing now, without waiting out the retry backoff. Returns at once. */
  'helper:install-tools': { request: z.void(), response: HelperStatus },
  /** Check: this tool's version, and its project's latest release. Downloads nothing. */
  'helper:check-tool': { request: z.object({ id: ToolId }), response: HelperStatus },
  /** Update or Install: the verified installer, for this tool. Returns at once; progress shows in the status. */
  'helper:update-tool': { request: z.object({ id: ToolId }), response: z.object({ status: HelperStatus, reason: z.string().nullable() }) },
  /** The helper's token, for pasting into a player this app does not serve. Shown, never logged. */
  'helper:token': { request: z.void(), response: z.object({ token: z.string().nullable() }) },

  'tv:links': { request: z.void(), response: TvLinks },
  /** Reads the link in the main process and keeps it only if it holds a playlist or a guide. */
  'tv:add': { request: z.object({ kind: TvLinkKind, url: z.string().min(1).max(2048) }), response: z.object({ link: TvLink.nullable(), reason: z.string().nullable() }) },
  'tv:remove': { request: z.object({ id: z.string().min(1).max(80) }), response: z.object({ ok: z.boolean() }) },
  'tv:refresh': { request: z.object({ id: z.string().min(1).max(80) }), response: z.object({ link: TvLink.nullable(), reason: z.string().nullable() }) },

  /** Starts a search; answers when it has finished (or failed, with the reason). Chunks come as `event:catalog-chunk`. */
  'catalog:search': { request: CatalogSearchIpc, response: z.object({ reason: z.string().max(600).nullable() }) },
  /** Stops a search the window no longer wants (a new one typed over it): the helper stops asking. */
  'catalog:cancel': { request: z.object({ searchId: CatalogSearchId }), response: z.object({ ok: z.boolean() }) },
  'catalog:album': { request: z.strictObject({ id: z.string().min(3).max(260), ...ListPage }), response: Answer(CatalogAlbumDetail) },
  'catalog:artist': { request: z.strictObject({ id: z.string().min(3).max(260), albumsOffset: z.number().int().min(0).max(500).default(0) }), response: Answer(CatalogArtistDetail) },
  /** Any page of a pasted link's list: every song, page by page (no 200 cap). */
  'catalog:resolve': { request: z.strictObject({ url: z.string().min(1).max(2048), ...ListPage }), response: Answer(CatalogResolveResult) },
  'catalog:lyrics': { request: z.strictObject({ title: z.string().min(1).max(300), artist: z.string().min(1).max(300), album: z.string().max(300).optional(), durationSec: z.number().int().min(1).max(7200).optional() }), response: Answer(CatalogLyrics) },
  'catalog:enrich': { request: z.strictObject({ isrc: z.string().max(20).optional(), title: z.string().max(300).optional(), artist: z.string().max(300).optional(), durationSec: z.number().int().min(1).max(7200).optional() }), response: Answer(CatalogEnrichment) },
  /** The helper's download path, as every download on this PC: from the song's best source, saved where Settings says. */
  'catalog:download': { request: z.strictObject({ track: CatalogTrack, basis: DownloadAuthorizationBasis, format: OutputFormat.optional() }), response: z.object({ job: HelperJob.nullable(), source: CatalogSource.nullable(), reason: z.string().max(600).nullable() }) },
  /** Starred albums and playlists, kept in this PC's library (the shared SavedCollection shape). */
  'catalog:saved': { request: z.void(), response: SavedList },
  'catalog:save': { request: SavedCollection, response: SavedList },
  'catalog:unsave': { request: CatalogCollectionRef.pick({ platform: true, kind: true, id: true }), response: SavedList },
  'catalog:filter': { request: z.void(), response: CatalogFilter },
  'catalog:filter:set': { request: CatalogFilter, response: CatalogFilter },
} as const satisfies Record<IpcChannel, { request: z.ZodType; response: z.ZodType }>;

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof IPC)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof IPC)[C]['response']>;

/** Events the main process pushes to the renderer. Same rule: an event not listed does not exist. */
export const IPC_EVENTS = {
  'event:scan-progress': ScanProgress,
  'event:hub-status': HubConnection,
  'event:transfer-progress': TransferProgress,
  'event:backup-progress': BackupProgress,
  'event:awsp-status': AwspStatus,
  'event:tv-links': TvLinks,
  'event:notice': z.object({ kind: z.enum(['info', 'warning', 'error']), message: z.string() }),
  /** One chunk of a running search, for the window that started it. */
  'event:catalog-chunk': z.object({ searchId: CatalogSearchId, chunk: CatalogSearchChunk }),
} as const satisfies Record<IpcEvent, z.ZodType>;

export type IpcEventPayload<E extends IpcEvent> = z.infer<(typeof IPC_EVENTS)[E]>;

export { IPC_CHANNELS, IPC_EVENT_NAMES };
export type { IpcChannel, IpcEvent };

/** Shape the preload script exposes on `window.companion`. */
export interface CompanionBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}
