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

export const LibraryFolder = z.object({
  id: z.uuid(),
  path: z.string().min(1),
  displayName: z.string().min(1).max(200),
  watch: z.boolean().default(true),
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
  /** Downloads land here; the person chooses it, and the app never writes outside it. */
  downloadDirectory: z.string().nullable().default(null),
  theme: z.enum(['system', 'light']).default('system'),
});
export type Preferences = z.infer<typeof Preferences>;

/**
 * Every channel, with the shape of its request and its result.
 *
 * A channel not listed here does not exist: the preload script exposes exactly these names, and the
 * main process refuses anything else.
 */
export const IPC = {
  'app:info': { request: z.void(), response: AppInfo },
  'app:preferences:get': { request: z.void(), response: Preferences },
  'app:preferences:set': { request: Preferences.partial(), response: Preferences },
  'app:open-external': { request: z.object({ url: z.string().url() }), response: z.object({ opened: z.boolean(), reason: z.string().nullable() }) },
  'app:reveal': { request: z.object({ trackId: z.uuid() }), response: z.object({ ok: z.boolean(), reason: z.string().nullable() }) },

  'library:folders': { request: z.void(), response: z.object({ items: z.array(LibraryFolder) }) },
  'library:add-folder': { request: z.void(), response: z.object({ folder: LibraryFolder.nullable(), reason: z.string().nullable() }) },
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

  'transfers:list': { request: z.void(), response: z.object({ items: z.array(TransferProgress) }) },
  'transfers:send': { request: z.object({ trackIds: z.array(z.uuid()).min(1).max(500) }), response: z.object({ queued: z.number().int(), reason: z.string().nullable() }) },
  'transfers:cancel': { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },

  'backup:create': { request: z.void(), response: z.object({ backup: BackupSummary.nullable(), reason: z.string().nullable() }) },
  'backup:restore': { request: z.void(), response: z.object({ restored: z.boolean(), reason: z.string().nullable(), summary: BackupSummary.nullable() }) },
  'backup:export-playlists': { request: z.void(), response: z.object({ path: z.string().nullable(), count: z.number().int(), reason: z.string().nullable() }) },

  'downloads:list': { request: z.void(), response: z.object({ items: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), percent: z.number().nullable(), error: z.string().nullable(), path: z.string().nullable() })) }) },
  'downloads:choose-directory': { request: z.void(), response: z.object({ path: z.string().nullable() }) },
} as const satisfies Record<IpcChannel, { request: z.ZodType; response: z.ZodType }>;

export type IpcRequest<C extends IpcChannel> = z.infer<(typeof IPC)[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof IPC)[C]['response']>;

/** Events the main process pushes to the renderer. Same rule: an event not listed does not exist. */
export const IPC_EVENTS = {
  'event:scan-progress': ScanProgress,
  'event:hub-status': HubConnection,
  'event:transfer-progress': TransferProgress,
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
