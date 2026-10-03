/**
 * The Electron main process.
 *
 * Structure mirrors the security model: this file owns the window, the database and the IPC
 * handlers, and it is the only place with filesystem or network access. The renderer reaches it
 * exclusively through the channels declared in `shared/ipc.ts`, each validated on the way in and
 * on the way out — so a compromised renderer can call only what is listed there, with only the
 * shapes declared there.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, safeStorage, session, shell, Tray, nativeImage } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTRACTS_VERSION, EqPreset, Playlist, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { IPC, Preferences, type AppInfo, type BackupSettingsPatch, type FolderKind, type IpcChannel, type LibraryFolder, type PreferencesPatch, type ScanProgress, type TransferProgress, type TvLinkKind } from '../shared/ipc.js';
import { absolutePathOf, scanFolder } from './library.js';
import { runTempoPass } from './tempo-analysis.js';
import { FolderWatcher } from './watcher.js';
import { HubClient } from './hub.js';
import { BackupManager } from './backup.js';
import { EmbeddedHelper } from './helper.js';
import { AwspSupervisor, findAwspBinary } from './awsp.js';
import { appUrlGuard, applySessionSecurity, applyWindowSecurity, enforceSingleInstance, guardWebContents, isTrustedSender, openExternally } from './security.js';
import { CompanionStore, openCompanionDb } from './store.js';
import { LiveTv } from './live-tv/index.js';
import { APP_ID, PRODUCT_NAME } from '../shared/identity.js';
import { sharingIsOn } from '../shared/sharing.js';

const DEV_SERVER_URL = process.env['NP_DEV_SERVER_URL'] ?? null;
const INDEX_FILE = join(__dirname, '..', 'renderer', 'index.html');
/** The only page the window may show, and the only page whose IPC requests are answered. */
const isAppUrl = appUrlGuard(DEV_SERVER_URL, INDEX_FILE);
const PREFERENCES_KEY = 'preferences';
const DEFAULT_PREFERENCES: Preferences = Preferences.parse({});
/** Finished transfers kept for the Transfers screen; older ones are dropped. */
const MAX_FINISHED_TRANSFERS = 100;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: CompanionStore | null = null;
let hub: HubClient | null = null;
let backups: BackupManager | null = null;
let helper: EmbeddedHelper | null = null;
let awsp: AwspSupervisor | null = null;
let liveTv: LiveTv | null = null;
let scanning: AbortController | null = null;
let tempoPass: AbortController | null = null;
let watcher: FolderWatcher | null = null;
let isQuitting = false;
const transfers = new Map<string, TransferProgress>();
const uploads = new Map<string, AbortController>();
/** Uploads run one after another: each hashes and reads a whole file. */
let uploadQueue: Promise<void> = Promise.resolve();
/**
 * Preferences are cached in memory. Window close handlers read them while the app quits, and by
 * then the database may already be closed.
 */
let preferencesCache: Preferences | null = null;

/**
 * Where this installation keeps its database, logs and paired-hub credentials.
 *
 * The portable build sets `PORTABLE_EXECUTABLE_DIR` to the folder holding the .exe, and the data
 * goes there rather than into the Windows user profile. That is the whole point of a portable
 * build: run it from a USB stick, take the stick away, and nothing of yours is left on the machine.
 * Installed builds use the normal per-user application-data folder.
 */
function dataDir(): string {
  // Both names are machine identifiers and did not change when the product was renamed: the
  // portable folder is spelled out here, and an installed copy's folder comes from the package
  // name (`now-playing-companion`), not from the product name.
  const portableRoot = process.env['PORTABLE_EXECUTABLE_DIR'];
  return portableRoot ? join(portableRoot, 'NowPlayingCompanion-data') : app.getPath('userData');
}

function send<T>(channel: string, payload: T): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notice(kind: 'info' | 'warning' | 'error', message: string): void {
  send('event:notice', { kind, message });
}

function preferences(): Preferences {
  if (preferencesCache) return preferencesCache;
  if (!store?.isOpen) return DEFAULT_PREFERENCES;
  const saved = Preferences.safeParse(store.get<unknown>(PREFERENCES_KEY, {}) ?? {});
  preferencesCache = saved.success ? saved.data : DEFAULT_PREFERENCES;
  return preferencesCache;
}

function savePreferences(next: Preferences): Preferences {
  const before = preferences();
  store!.set(PREFERENCES_KEY, next, new Date().toISOString());
  preferencesCache = next;
  syncWatchers();
  if (before.helperPort !== next.helperPort) void helper?.restart(next.helperPort);
  return next;
}

/**
 * Whether this PC's library is synced to the hub. Pairing with a hub that grants `library:share` is
 * the decision to share — that is what pairing a companion is for, and it is how the app behaved
 * before the checkbox was wired — so sharing is on from then until it is turned off in Remote ▸
 * What is shared. Turning it off is remembered for that hub; a hub that never granted the
 * permission is never shared with.
 */
function sharingEnabled(): boolean {
  if (store?.isOpen !== true) return false;
  return sharingIsOn(store.get<boolean | null>('shareLibrary', null), hub?.hasScope('library:share') === true);
}

/** The helper's estimate route measures the companion's folders: restarted when they change. */
function syncHelperFolders(): void {
  if (helper && store?.isOpen) void helper.restart(preferences().helperPort);
}

/**
 * Point the watchers at whatever is in the library now.
 *
 * Called after anything that could change the answer — a folder added or removed, the preference
 * toggled, the app started. `sync` is idempotent, so calling it when nothing moved costs nothing.
 */
function syncWatchers(): void {
  if (!store?.isOpen) return;
  watcher ??= new FolderWatcher({
    // The same incremental scan the Scan button runs: unchanged files are skipped by size and
    // mtime, so a folder that gained one track does not re-read the other eighty thousand.
    onChanged: (folderId) => startScan(folderId),
    onError: (folderId, error) => console.error(`Watching folder ${folderId} failed:`, error.message),
  });
  watcher.sync(
    store.listFolders(() => true).map((folder) => ({ id: folder.id, path: folder.path, watch: folder.watch })),
    preferences().watchFolders,
  );
}

/** Spread rather than assigned, so a missing icon file simply leaves the option out. */
function iconOption(): { icon?: string } {
  const icon = resourcePath('icon.ico');
  return icon ? { icon } : {};
}

/**
 * The window is the one `design/frontends/airwave-companion.html` drew: a title and four tools on
 * one sheet of chrome, with nothing above it. So the operating system's title bar is hidden and the
 * page draws the title itself — but the window keeps its frame: `titleBarOverlay` has Windows draw
 * its own minimise, maximise and close over the top-right of that chrome, with Snap Layouts, the
 * system menu and resizing all still Windows' own. The overlay is clear, so the chrome's gradient
 * runs under the buttons unbroken, and its height is the design's title strip (`.titlebar`, 26px).
 * The page marks the chrome as the drag region (`styles.css`).
 */
const TITLE_BAR_HEIGHT = 26;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // The design's proportions: a narrow preferences window, taller than it is wide.
    width: 640,
    height: 760,
    minWidth: 520,
    minHeight: 440,
    useContentSize: true,
    show: false,
    backgroundColor: '#ececec',
    title: PRODUCT_NAME,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#3f4245', height: TITLE_BAR_HEIGHT },
    ...iconOption(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // The three settings that make the renderer a browser tab rather than a program:
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // No remote content is ever loaded, so allowing insecure content would only be a hazard.
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  applyWindowSecurity(window, isAppUrl);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    // Closing hides to the tray when the person asked for that, so a scan or transfer survives.
    if (!isQuitting && preferences().minimizeToTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL) void window.loadURL(DEV_SERVER_URL);
  else void window.loadFile(INDEX_FILE);

  return window;
}

/**
 * Resolve a file in `resources/`, which sits two levels above the bundled main process in both
 * layouts: `dist/main/` in development and `app.asar/dist/main/` once packaged. Returns null rather
 * than a broken path so callers can decide what a missing resource means.
 */
function resourcePath(name: string): string | null {
  const candidate = join(__dirname, '..', '..', 'resources', name);
  return existsSync(candidate) ? candidate : null;
}

function createTray(): void {
  // Prefer the ICO: it carries 16 and 32 pixel bitmaps, so Windows picks the right one for the
  // person's display scaling instead of resampling a single PNG.
  const iconPath = resourcePath('tray.ico') ?? resourcePath('tray-32.png');
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow() },
      { label: 'Scan Library Now', click: () => void startScan() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => showWindow());
}

function showWindow(): void {
  if (isQuitting || !store) return;
  mainWindow ??= createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------------------------------------------------------- scanning */

async function startScan(folderId?: string): Promise<{ started: boolean; reason: string | null }> {
  if (scanning) return { started: false, reason: 'A scan is already running.' };
  // A new scan supersedes the previous scan's measurement pass; its leftovers re-queue anyway.
  tempoPass?.abort();
  const folders = folderId ? [store!.findFolder(folderId)].filter(Boolean) : store!.raw.prepare<[], { id: string; path: string }>('SELECT id, path FROM folders').all();
  if (!folders.length) return { started: false, reason: 'No folders have been added yet.' };

  const controller = new AbortController();
  scanning = controller;
  const signal = controller.signal;
  void (async () => {
    try {
      for (const folder of folders as Array<{ id: string; path: string }>) {
        if (signal.aborted || !store?.isOpen) break;
        if (!existsSync(folder.path)) {
          // A disconnected drive is reported rather than silently emptying the library.
          store.updateFolderStats(folder.id, { trackCount: store.countTracks(folder.id), sizeBytes: 0, lastScanAt: new Date().toISOString(), error: 'This folder is not available right now. If it is on a removable or network drive, reconnect it.' });
          send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: 0, indexed: 0, skipped: 0, currentName: null, done: true, error: 'Folder unavailable' });
          continue;
        }
        try {
          const result = await scanFolder(store, folder, {
            signal,
            onProgress: (progress) => send<ScanProgress>('event:scan-progress', { folderId: folder.id, ...progress, done: false, error: null }),
          });
          send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: result.added + result.updated + result.skipped, indexed: result.added + result.updated, skipped: result.skipped, currentName: null, done: true, error: null });
          if (result.unreadable.length) notice('warning', `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read in ${folder.path}.`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: 0, indexed: 0, skipped: 0, currentName: null, done: true, error: reason });
          if (store?.isOpen) store.updateFolderStats(folder.id, { trackCount: store.countTracks(folder.id), sizeBytes: 0, lastScanAt: new Date().toISOString(), error: reason });
        }
      }
    } finally {
      // Whatever happened, a finished scan must not block the next one.
      if (scanning === controller) scanning = null;
    }
    // The measurement pass rides behind the scan it belongs to: files that still have no tempo
    // get one from their own audio, one at a time. It carries its own controller because the
    // scan's is already released by now — the next scan, and quitting, abort it through that.
    if (!signal.aborted && store?.isOpen) await measureTempoBacklog();
  })().catch((err: unknown) => console.error('Library scan stopped:', err));
  return { started: true, reason: null };
}

/**
 * The tempo measurement pass over whatever still has no tempo. Runs behind every scan, and once
 * more when automatic setup lands FFmpeg (UX-SETUP-001), so a library scanned before FFmpeg existed
 * gets its tempos without a rescan. It owns `tempoPass`, so a new scan and quitting abort it.
 */
async function measureTempoBacklog(): Promise<void> {
  if (!store?.isOpen) return;
  tempoPass?.abort();
  const pass = new AbortController();
  tempoPass = pass;
  try {
    const tools = await helper?.checkTools().catch(() => null);
    const ffmpegPath = tools?.tools.find((t) => t.id === 'ffmpeg' && t.present)?.path ?? null;
    await runTempoPass({
      store,
      ffmpegPath,
      signal: pass.signal,
      resolvePath: (record) => absolutePathOf(store!, record.id),
    });
    // No invented event: the Library view re-queries whenever it looks (Task 3 pins that).
  } finally {
    if (tempoPass === pass) tempoPass = null;
  }
}

/** Automatic setup landed a tool. FFmpeg unlocks the tempo backlog and the streaming sidecar's transcoder. */
function onToolInstalled(id: 'yt-dlp' | 'spotdl' | 'ffmpeg'): void {
  if (id !== 'ffmpeg' || isQuitting) return;
  awsp?.toolsChanged();
  // A scan in progress runs the pass itself when it finishes.
  if (!scanning) void measureTempoBacklog().catch((err: unknown) => console.error('Tempo pass stopped:', err));
}

/* --------------------------------------------------------------- transfers */

function putTransfer(progress: TransferProgress): void {
  transfers.set(progress.id, progress);
  send('event:transfer-progress', progress);
}

/** Keep every active transfer and only the most recent finished ones. */
function pruneTransfers(): void {
  const finished = [...transfers.values()].filter((t) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled');
  for (const t of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TRANSFERS))) transfers.delete(t.id);
}

async function runUpload(id: string, trackId: string): Promise<void> {
  const queued = transfers.get(id);
  if (!queued || queued.state !== 'queued' || isQuitting) return; // Cancelled while waiting.
  const controller = new AbortController();
  uploads.set(id, controller);
  putTransfer({ ...queued, state: 'running' });
  const result = await hub!
    .uploadTrack(
      trackId,
      (bytesDone, bytesTotal) => {
        const current = transfers.get(id);
        if (current?.state === 'running') putTransfer({ ...current, bytesDone, bytesTotal });
      },
      controller.signal,
    )
    .catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
  uploads.delete(id);
  const current = transfers.get(id);
  // A cancelled transfer stays cancelled, whatever the upload reported afterwards.
  if (!current || current.state !== 'running') return;
  putTransfer({ ...current, state: result.ok ? 'completed' : 'failed', error: result.reason });
  pruneTransfers();
}

/* ------------------------------------------------------------ IPC handlers */

/**
 * Register a channel with validation on both sides.
 *
 * The sender is checked first: only the app's own page may call a channel, so a frame or page that
 * somehow ended up in the window gets nothing.
 *
 * Validating the *response* as well as the request is not paranoia about our own code: it is how a
 * shape change in the contract shows up as a clear error during development rather than as a
 * renderer quietly rendering `undefined`.
 */
function handle<C extends IpcChannel>(channel: C, handler: (request: unknown) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    if (!isTrustedSender(event, isAppUrl)) throw new Error(`${channel}: refused a request from a page that is not this app`);
    const parsedRequest = IPC[channel].request.safeParse(raw ?? undefined);
    if (!parsedRequest.success) throw new Error(`${channel}: ${parsedRequest.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const result = await handler(parsedRequest.data);
    const parsedResponse = IPC[channel].response.safeParse(result);
    if (!parsedResponse.success) throw new Error(`${channel} produced an unexpected result: ${parsedResponse.error.issues.map((i) => i.message).join('; ')}`);
    return parsedResponse.data;
  });
}

function registerHandlers(): void {
  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions['electron'] ?? 'unknown',
    chrome: process.versions['chrome'] ?? 'unknown',
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    contractsVersion: CONTRACTS_VERSION,
    protocolVersion: WS_PROTOCOL_VERSION,
    dataDir: dataDir(),
    // Baked in by `scripts/build.mjs`, not read from the environment the app happens to start in:
    // an unsigned build says so rather than repeating back whatever a variable claims.
    signed: typeof __NP_SIGNED__ === 'boolean' ? __NP_SIGNED__ : false,
    updateFeedUrl: process.env['NP_UPDATE_FEED'] ?? null,
  }));

  handle('app:preferences:get', () => preferences());
  handle('app:preferences:set', (request) => {
    const patch = request as PreferencesPatch;
    const next: Preferences = { ...preferences() };
    if (patch.launchAtLogin !== undefined) next.launchAtLogin = patch.launchAtLogin;
    if (patch.minimizeToTray !== undefined) next.minimizeToTray = patch.minimizeToTray;
    if (patch.watchFolders !== undefined) next.watchFolders = patch.watchFolders;
    if (patch.autoSync !== undefined) next.autoSync = patch.autoSync;
    if (patch.theme !== undefined) next.theme = patch.theme;
    if (patch.helperPort !== undefined) next.helperPort = patch.helperPort;
    savePreferences(next);
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    return next;
  });
  handle('app:preferences:reset', () => {
    savePreferences(DEFAULT_PREFERENCES);
    app.setLoginItemSettings({ openAtLogin: DEFAULT_PREFERENCES.launchAtLogin });
    return DEFAULT_PREFERENCES;
  });

  handle('app:open-external', async (request) => openExternally((request as { url: string }).url));

  // The folder is the app's own and is named here, not by the page: there is no path in the request.
  handle('app:open-data-folder', async () => {
    const failure = await shell.openPath(dataDir());
    return failure ? { ok: false, reason: 'Windows could not open that folder. Its location is shown above.' } : { ok: true, reason: null };
  });

  handle('app:reveal', (request) => {
    const path = absolutePathOf(store!, (request as { trackId: string }).trackId);
    if (!path || !existsSync(path)) return { ok: false, reason: 'That file is not where it was. It may have been moved, renamed or deleted.' };
    shell.showItemInFolder(path);
    return { ok: true, reason: null };
  });

  handle('library:folders', () => ({ items: store!.listFolders((path) => existsSync(path)) }));

  handle('library:add-folder', async (request) => {
    const kind = (request as { kind: FolderKind }).kind;
    const titles: Record<FolderKind, string> = { music: 'Choose a music folder', tv: 'Choose a TV folder', movies: 'Choose a movies folder' };
    const result = await dialog.showOpenDialog(mainWindow!, { title: titles[kind], properties: ['openDirectory'], buttonLabel: 'Add Folder' });
    if (result.canceled || !result.filePaths[0]) return { folder: null, reason: null };
    const path = result.filePaths[0];
    if (store!.findFolderByPath(path)) return { folder: null, reason: 'That folder has already been added.' };
    const folder = { id: uuidv7(), path, displayName: path.split(/[\\/]/).filter(Boolean).pop() ?? path, kind, now: new Date().toISOString() };
    store!.addFolder(folder);
    // Only music is indexed; TV and movie folders are kept, watched for the backup, and left alone.
    if (kind === 'music') void startScan(folder.id);
    syncWatchers();
    syncHelperFolders();
    const added: LibraryFolder = { id: folder.id, path, displayName: folder.displayName, watch: true, kind, trackCount: 0, sizeBytes: 0, lastScanAt: null, lastScanError: null, available: true };
    return { folder: added, reason: null };
  });

  handle('library:remove-folder', (request) => {
    store!.removeFolder((request as { folderId: string }).folderId, new Date().toISOString());
    syncWatchers();
    syncHelperFolders();
    return { ok: true };
  });

  handle('library:scan', (request) => startScan((request as { folderId?: string }).folderId));

  handle('library:tracks', (request) => store!.searchTracks(request as { query?: string; limit: number; offset: number }));
  // A stored record that no longer fits the contract is left out rather than breaking the list.
  handle('library:playlists', () => ({ items: store!.listPlaylists().filter((p) => Playlist.safeParse(p).success) }));
  handle('library:presets', () => ({ items: store!.listPresets().filter((p) => EqPreset.safeParse(p).success) }));

  handle('hub:status', () => hub!.getStatus());
  handle('hub:pair-start', (request) => hub!.startPairing((request as { endpoint: string }).endpoint, (request as { code: string }).code));
  handle('hub:pair-await', (request) => hub!.awaitPairing((request as { sessionId: string }).sessionId));
  handle('hub:forget', async () => {
    const status = await hub!.forget();
    // Turning sharing off was a choice about that hub. The next one starts as the first did.
    store!.set('shareLibrary', null, new Date().toISOString());
    return status;
  });

  handle('hub:sync-now', async () => {
    // The window says sharing is opted into and that turning it off stops syncing; this is where
    // that is true. With no hub paired, sync itself says so.
    if (hub!.getStatus().endpoint && !sharingEnabled()) return { started: false, reason: 'Sharing is off, so nothing was synced. Turn on “Let the hub see what music is on this PC” first.' };
    const result = await hub!.sync();
    if (result.reason) return { started: false, reason: result.reason };
    notice('info', `Synced: sent ${result.pushed}, received ${result.pulled}${result.conflicts ? `, ${result.conflicts} conflicts resolved` : ''}.`);
    return { started: true, reason: null };
  });

  handle('hub:share-library', (request) => {
    const enabled = (request as { enabled: boolean }).enabled;
    if (enabled && !hub!.hasScope('library:share')) return { enabled: false, reason: 'The hub has not given this companion permission to share its library. Change its permissions in the hub, under Devices.' };
    store!.set('shareLibrary', enabled, new Date().toISOString());
    hub!.scheduleLiveTvPush(0);
    return { enabled, reason: null };
  });
  handle('hub:sharing', () => ({ enabled: sharingEnabled() }));

  handle('transfers:list', () => ({ items: [...transfers.values()] }));

  handle('transfers:send', async (request) => {
    const ids = (request as { trackIds: string[] }).trackIds;
    if (!hub!.getStatus().connected) return { queued: 0, reason: 'No hub is connected.' };
    let queued = 0;
    for (const trackId of ids) {
      const record = store!.findTrack(trackId);
      if (!record || record.deletedAt) continue;
      const id = uuidv7();
      putTransfer({ id, kind: 'upload', trackTitle: record.track.title, bytesDone: 0, bytesTotal: record.sizeBytes, state: 'queued', error: null });
      queued += 1;
      uploadQueue = uploadQueue.then(() => runUpload(id, trackId)).catch((err: unknown) => console.error('Upload failed:', err));
    }
    pruneTransfers();
    return { queued, reason: queued ? null : 'None of those tracks are on this computer any more.' };
  });

  handle('transfers:cancel', (request) => {
    const id = (request as { id: string }).id;
    const existing = transfers.get(id);
    if (!existing || (existing.state !== 'queued' && existing.state !== 'running')) return { ok: false };
    // Stops the upload itself, not just the row on screen.
    uploads.get(id)?.abort();
    putTransfer({ ...existing, state: 'cancelled', error: null });
    pruneTransfers();
    return { ok: true };
  });

  handle('backup:settings:get', () => backups!.settings());
  handle('backup:settings:set', async (request) => {
    const next = backups!.update(request as BackupSettingsPatch);
    // A smaller kept count applies at once, not after the next backup.
    await backups!.prune();
    return next;
  });

  handle('backup:pick-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Where should backups go?', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Use this folder' });
    if (result.canceled || !result.filePaths[0]) return { settings: backups!.settings(), reason: null };
    const settings = backups!.setDir(result.filePaths[0]);
    syncHelperFolders();
    return { settings, reason: null };
  });

  handle('backup:estimate', () => backups!.estimate());
  handle('backup:list', async () => ({ items: await backups!.list() }));
  handle('backup:create', () => backups!.create());
  handle('backup:remove', (request) => backups!.remove((request as { id: string }).id));

  handle('backup:restore', async (request) => {
    const id = (request as { id?: string }).id;
    if (id) return backups!.restoreArchive(id);
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a backup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { restored: false, reason: null, summary: null };
    let text: string;
    try {
      text = await readFile(result.filePaths[0], 'utf8');
    } catch (err) {
      return { restored: false, reason: `That file could not be read as a backup: ${err instanceof Error ? err.message : String(err)}`, summary: null };
    }
    const restored = backups!.applyFile(text, result.filePaths[0]);
    // Folders are not restored: they name paths that may not exist on this machine.
    if (restored.restored) notice('info', 'Playlists and presets were restored. Music folders are not restored from a backup — add them again, since their locations are specific to each computer.');
    return restored;
  });

  handle('awsp:status', () => awsp!.getStatus());
  handle('awsp:set-enabled', (request) => awsp!.setEnabled((request as { enabled: boolean }).enabled));
  handle('awsp:set-port', (request) => awsp!.setPort((request as { port: number | null }).port));
  handle('awsp:new-code', () => awsp!.newPairingCode());
  handle('awsp:revoke', (request) => awsp!.revoke((request as { id: string }).id));
  handle('awsp:set-tier', (request) => awsp!.setTierCap((request as { id: string }).id, (request as { tier: 'lossless' | 'high' | 'saver' }).tier));

  handle('helper:status', () => helper!.settledStatus());
  handle('helper:check-tools', () => helper!.checkTools());
  handle('helper:install-tools', () => helper!.installTools());
  handle('helper:token', () => ({ token: helper!.token() }));

  handle('tv:links', () => liveTv!.list());
  handle('tv:add', (request) => liveTv!.add((request as { kind: TvLinkKind }).kind, (request as { url: string }).url));
  handle('tv:remove', (request) => liveTv!.remove((request as { id: string }).id));
  handle('tv:refresh', (request) => liveTv!.refresh((request as { id: string }).id));

  handle('backup:export-playlists', async () => {
    const playlists = store!.listPlaylists();
    if (!playlists.length) return { path: null, count: 0, reason: 'There are no playlists to export.' };
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Export playlists', defaultPath: join(app.getPath('documents'), 'playlists.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { path: null, count: 0, reason: null };
    await writeFile(result.filePath, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), playlists }, null, 2), 'utf8');
    return { path: result.filePath, count: playlists.length, reason: null };
  });

}

/* ------------------------------------------------------------------ startup */

// The companion has no use for Electron's default application menu — the File / Edit / View /
// Window bar. Every one of those entries either opens a window the app does not have, or offers
// a shortcut to something with no accessible name. Removing the whole bar (rather than the
// auto-hide option, which still lets Alt bring it back) is what makes the window look like the
// program it is instead of a browser frame.
//
// This is not the title bar. The window keeps its frame — it is never made frameless — so
// minimise, maximise and close are Windows' own buttons, drawn over the page's chrome by the
// title-bar overlay (see createWindow), where Windows users expect them.
//
// The TRAY menu is a different object and is untouched — `createTray()` builds it with
// Menu.buildFromTemplate, and Open / Scan library now / Quit all still work from the tray.
//
// It runs before whenReady() so the menu never flashes into existence, and before the first
// window is created, since a window's menu is fixed when it is constructed.
Menu.setApplicationMenu(null);

// Windows groups a window, its taskbar button, its Start-menu entry, its jump list and its toasts
// by an Application User Model ID. electron-builder writes that ID into the installer's shortcuts
// and registry entries from `appId` (electron-builder.config.cjs); this declares the same string to
// the shell at runtime. Without it — or with a different value — Windows treats the pinned shortcut
// and the running window as two different programs, so pinning "doesn't stick" and relaunching
// from the pin opens a second taskbar button. It is set before anything creates a window, and
// before the single-instance lock, because the lock is keyed on the userData directory.
// APP_ID is the one place this string lives; tests/contract/app-identity.test.ts pins it against
// the builder config so the two cannot drift.
app.setAppUserModelId(APP_ID);

// Redirect Electron's own caches and state alongside the database, so a portable build really is
// self-contained rather than leaving a cache folder behind in the profile. This comes before
// the single-instance lock, which is keyed on the userData directory.
{
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
}

// A second launch may arrive before this one is ready; the window is shown once it is.
if (!enforceSingleInstance(() => void app.whenReady().then(() => showWindow()))) {
  app.quit();
} else {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, isAppUrl));

  void app.whenReady().then(() => {
    store = new CompanionStore(openCompanionDb(join(dataDir(), 'companion.sqlite')));
    hub = new HubClient(store, `${process.env['COMPUTERNAME'] ?? 'Windows'} companion`, (status) => send('event:hub-status', status), {
      secretBox: safeStorage,
      appVersion: app.getVersion(),
      onNotice: (message) => notice('warning', message),
    });
    backups = new BackupManager({
      store,
      readSettings: () => ({ preferences: preferences() }),
      writeSettings: (settings) => {
        const parsed = Preferences.safeParse((settings as { preferences?: unknown }).preferences ?? {});
        if (parsed.success) savePreferences({ ...parsed.data, launchAtLogin: preferences().launchAtLogin });
      },
      onProgress: (progress) => send('event:backup-progress', progress),
      onNotice: notice,
    });
    liveTv = new LiveTv({
      store,
      cacheDir: join(dataDir(), 'live-tv'),
      version: app.getVersion(),
      log: (line) => console.info(line),
      // A change to Live TV also refreshes the hub's copy (only while this PC shares with it).
      onChange: (links) => {
        send('event:tv-links', links);
        hub?.scheduleLiveTvPush();
      },
    });
    hub.setLiveTvSource({ channels: () => liveTv!.channels(), guide: () => liveTv!.guide(), sharing: sharingEnabled });
    helper = new EmbeddedHelper({
      store,
      secretBox: safeStorage,
      version: app.getVersion(),
      dataDir: dataDir(),
      log: (line) => console.info(`[helper] ${line}`),
      backup: () => ({ folders: backups!.folders(), backupDir: backups!.settings().dir }),
      onToolInstalled,
      // The player reads its channels and its now/next from here (GET /helper/v1/tv/…).
      tv: { channels: () => liveTv!.channels(), guide: () => liveTv!.guide() },
    });
    applySessionSecurity(session.defaultSession, DEV_SERVER_URL, isAppUrl);
    registerHandlers();
    mainWindow = createWindow();
    createTray();
    void hub.refresh();
    void helper.start(preferences().helperPort);
    backups.start();
    liveTv.start();
    awsp = new AwspSupervisor({
      store,
      secretBox: safeStorage,
      binary: findAwspBinary(join(__dirname, '..', '..'), app.isPackaged ? process.resourcesPath : null),
      libraryDb: join(dataDir(), 'companion.sqlite'),
      cacheDir: join(dataDir(), 'awsp-cache'),
      serverName: `${process.env['COMPUTERNAME'] ?? 'Windows'} companion`,
      onStatus: (status) => send('event:awsp-status', status),
      log: (line) => console.info(line),
      ffmpegPath: () => helper?.ffmpegPath() ?? null,
    });
    awsp.boot();
    powerMonitor.on('resume', () => awsp?.onResume());
    if (preferences().autoSync && sharingEnabled()) void hub.sync();
    // Folders added in an earlier session are watched again from start-up, not from the first
    // time something touches the preferences.
    syncWatchers();
  });

  app.on('window-all-closed', () => {
    // Windows convention: closing the last window quits, unless the tray is holding the app open.
    if (isQuitting || !preferences().minimizeToTray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    scanning?.abort();
    tempoPass?.abort();
    for (const upload of uploads.values()) upload.abort();
    tray?.destroy();
    tray = null;
  });

  // The database closes last: windows are closed (and their close handlers have run) by now.
  app.on('will-quit', () => {
    backups?.stop();
    liveTv?.stop();
    void helper?.stop();
    void awsp?.stop();
    void watcher?.close();
    watcher = null;
    store?.close();
  });
}
