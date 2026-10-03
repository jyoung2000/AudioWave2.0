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
import { EqPreset, Playlist, Track } from '@now-playing/contracts';
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
      settings: z.boolean().default(true),
    })
    .default({ music: true, tv: false, movies: false, playlists: true, presets: true, settings: true }),
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
  parts: z.array(z.enum(['music', 'tv', 'movies', 'playlists', 'presets', 'settings'])),
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
});
export type AwspDevice = z.infer<typeof AwspDevice>;

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
});
export type AppInfo = z.infer<typeof AppInfo>;

export const Preferences = z.object({
  launchAtLogin: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  watchFolders: z.boolean().default(true),
  autoSync: z.boolean().default(false),
  theme: z.enum(['system', 'light']).default('system'),
  /** The port the embedded helper listens on; the player scans 17342–17345. */
  helperPort: z.number().int().min(1024).max(65535).default(17342),
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
});
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

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

  'library:folders': { request: z.void(), response: z.object({ items: z.array(LibraryFolder) }) },
  'library:add-folder': { request: z.object({ kind: FolderKind.default('music') }).default({ kind: 'music' }), response: z.object({ folder: LibraryFolder.nullable(), reason: z.string().nullable() }) },
  'library:remove-folder': { request: z.object({ folderId: z.uuid() }), response: z.object({ ok: z.boolean() }) },
  'library:scan': { request: z.object({ folderId: z.uuid().optional() }), response: z.object({ started: z.boolean(), reason: z.string().nullable() }) },
  'library:tracks': { request: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).default(200), offset: z.number().int().nonnegative().default(0) }), response: z.object({ items: z.array(Track), total: z.number().int() }) },
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

  'awsp:status': { request: z.void(), response: AwspStatus },
  'awsp:set-enabled': { request: z.object({ enabled: z.boolean() }), response: AwspStatus },
  'awsp:set-port': { request: z.object({ port: z.number().int().min(1024).max(65535).nullable() }), response: AwspStatus },
  'awsp:new-code': { request: z.void(), response: AwspStatus },
  'awsp:revoke': { request: z.object({ id: z.string().min(1).max(200) }), response: AwspStatus },
  'awsp:set-tier': { request: z.object({ id: z.string().min(1).max(200), tier: AwspTier }), response: AwspStatus },

  'helper:status': { request: z.void(), response: HelperStatus },
  'helper:check-tools': { request: z.void(), response: HelperStatus },
  /** "Try Again": set up every tool that is missing now, without waiting out the retry backoff. Returns at once. */
  'helper:install-tools': { request: z.void(), response: HelperStatus },
  /** The helper's token, for pasting into a player this app does not serve. Shown, never logged. */
  'helper:token': { request: z.void(), response: z.object({ token: z.string().nullable() }) },

  'tv:links': { request: z.void(), response: TvLinks },
  /** Reads the link in the main process and keeps it only if it holds a playlist or a guide. */
  'tv:add': { request: z.object({ kind: TvLinkKind, url: z.string().min(1).max(2048) }), response: z.object({ link: TvLink.nullable(), reason: z.string().nullable() }) },
  'tv:remove': { request: z.object({ id: z.string().min(1).max(80) }), response: z.object({ ok: z.boolean() }) },
  'tv:refresh': { request: z.object({ id: z.string().min(1).max(80) }), response: z.object({ link: TvLink.nullable(), reason: z.string().nullable() }) },
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
} as const satisfies Record<IpcEvent, z.ZodType>;

export type IpcEventPayload<E extends IpcEvent> = z.infer<(typeof IPC_EVENTS)[E]>;

export { IPC_CHANNELS, IPC_EVENT_NAMES };
export type { IpcChannel, IpcEvent };

/** Shape the preload script exposes on `window.companion`. */
export interface CompanionBridge {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}
