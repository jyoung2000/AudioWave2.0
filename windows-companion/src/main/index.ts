/**
 * The Electron main process.
 *
 * Structure mirrors the security model: this file owns the window, the database and the IPC
 * handlers, and it is the only place with filesystem or network access. The renderer reaches it
 * exclusively through the channels declared in `shared/ipc.ts`, each validated on the way in and
 * on the way out — so a compromised renderer can call only what is listed there, with only the
 * shapes declared there.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray, nativeImage } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTRACTS_VERSION, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { IPC, type AppInfo, type IpcChannel, type LibraryFolder, type Preferences, type ScanProgress, type TransferProgress } from '../shared/ipc.js';
import { absolutePathOf, scanFolder } from './library.js';
import { HubClient } from './hub.js';
import { applySessionSecurity, applyWindowSecurity, enforceSingleInstance, guardWebContents, openExternally } from './security.js';
import { CompanionStore, openCompanionDb } from './store.js';

const DEV_SERVER_URL = process.env['NP_DEV_SERVER_URL'] ?? null;
const PREFERENCES_KEY = 'preferences';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: CompanionStore | null = null;
let hub: HubClient | null = null;
let scanning: AbortController | null = null;
const transfers = new Map<string, TransferProgress>();

/**
 * Where this installation keeps its database, logs and paired-hub credentials.
 *
 * The portable build sets `PORTABLE_EXECUTABLE_DIR` to the folder holding the .exe, and the data
 * goes there rather than into the Windows user profile. That is the whole point of a portable
 * build: run it from a USB stick, take the stick away, and nothing of yours is left on the machine.
 * Installed builds use the normal per-user application-data folder.
 */
function dataDir(): string {
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
  return store!.get<Preferences>(PREFERENCES_KEY, { launchAtLogin: false, minimizeToTray: true, watchFolders: true, autoSync: false, downloadDirectory: null, theme: 'system' });
}

/** Spread rather than assigned, so a missing icon file simply leaves the option out. */
function iconOption(): { icon?: string } {
  const icon = resourcePath('icon.ico');
  return icon ? { icon } : {};
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#e8e8e8',
    title: 'Now Playing Companion',
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

  applyWindowSecurity(window, DEV_SERVER_URL);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    // Closing hides to the tray when the person asked for that, so a scan or transfer survives.
    if (preferences().minimizeToTray && !isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL) void window.loadURL(DEV_SERVER_URL);
  else void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  return window;
}

let isQuitting = false;

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
  tray.setToolTip('Now Playing Companion');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => showWindow() },
      { label: 'Scan library now', click: () => void startScan() },
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
  mainWindow ??= createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------------------------------------------------------- scanning */

async function startScan(folderId?: string): Promise<{ started: boolean; reason: string | null }> {
  if (scanning) return { started: false, reason: 'A scan is already running.' };
  const folders = folderId ? [store!.findFolder(folderId)].filter(Boolean) : store!.raw.prepare<[], { id: string; path: string }>('SELECT id, path FROM folders').all();
  if (!folders.length) return { started: false, reason: 'No folders have been added yet.' };

  scanning = new AbortController();
  const signal = scanning.signal;
  void (async () => {
    for (const folder of folders as Array<{ id: string; path: string }>) {
      if (signal.aborted) break;
      if (!existsSync(folder.path)) {
        // A disconnected drive is reported rather than silently emptying the library.
        store!.updateFolderStats(folder.id, { trackCount: store!.countTracks(folder.id), sizeBytes: 0, lastScanAt: new Date().toISOString(), error: 'This folder is not available right now. If it is on a removable or network drive, reconnect it.' });
        send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: 0, indexed: 0, skipped: 0, currentName: null, done: true, error: 'Folder unavailable' });
        continue;
      }
      try {
        const result = await scanFolder(store!, folder, {
          signal,
          onProgress: (progress) => send<ScanProgress>('event:scan-progress', { folderId: folder.id, ...progress, done: false, error: null }),
        });
        send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: result.added + result.updated + result.skipped, indexed: result.added + result.updated, skipped: result.skipped, currentName: null, done: true, error: null });
        if (result.unreadable.length) notice('warning', `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read in ${folder.path}.`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        store!.updateFolderStats(folder.id, { trackCount: store!.countTracks(folder.id), sizeBytes: 0, lastScanAt: new Date().toISOString(), error: reason });
        send<ScanProgress>('event:scan-progress', { folderId: folder.id, found: 0, indexed: 0, skipped: 0, currentName: null, done: true, error: reason });
      }
    }
    scanning = null;
  })();
  return { started: true, reason: null };
}

/* ------------------------------------------------------------ IPC handlers */

/**
 * Register a channel with validation on both sides.
 *
 * Validating the *response* as well as the request is not paranoia about our own code: it is how a
 * shape change in the contract shows up as a clear error during development rather than as a
 * renderer quietly rendering `undefined`.
 */
function handle<C extends IpcChannel>(channel: C, handler: (request: unknown) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (_event, raw: unknown) => {
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
    // True only when CI signed the build; an unsigned build says so rather than implying otherwise.
    signed: process.env['NP_SIGNED'] === '1',
    updateFeedUrl: process.env['NP_UPDATE_FEED'] ?? null,
  }));

  handle('app:preferences:get', () => preferences());
  handle('app:preferences:set', (request) => {
    const next = { ...preferences(), ...(request as Partial<Preferences>) };
    store!.set(PREFERENCES_KEY, next, new Date().toISOString());
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    return next;
  });

  handle('app:open-external', async (request) => openExternally((request as { url: string }).url));

  handle('app:reveal', (request) => {
    const path = absolutePathOf(store!, (request as { trackId: string }).trackId);
    if (!path || !existsSync(path)) return { ok: false, reason: 'That file is not where it was. It may have been moved, renamed or deleted.' };
    shell.showItemInFolder(path);
    return { ok: true, reason: null };
  });

  handle('library:folders', () => ({ items: store!.listFolders((path) => existsSync(path)) }));

  handle('library:add-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a music folder', properties: ['openDirectory'], buttonLabel: 'Add folder' });
    if (result.canceled || !result.filePaths[0]) return { folder: null, reason: null };
    const path = result.filePaths[0];
    if (store!.findFolderByPath(path)) return { folder: null, reason: 'That folder has already been added.' };
    const folder = { id: uuidv7(), path, displayName: path.split(/[\\/]/).filter(Boolean).pop() ?? path, now: new Date().toISOString() };
    store!.addFolder(folder);
    void startScan(folder.id);
    const added: LibraryFolder = { id: folder.id, path, displayName: folder.displayName, watch: true, trackCount: 0, sizeBytes: 0, lastScanAt: null, lastScanError: null, available: true };
    return { folder: added, reason: null };
  });

  handle('library:remove-folder', (request) => {
    store!.removeFolder((request as { folderId: string }).folderId, new Date().toISOString());
    return { ok: true };
  });

  handle('library:scan', (request) => startScan((request as { folderId?: string }).folderId));

  handle('library:tracks', (request) => store!.searchTracks(request as { query?: string; limit: number; offset: number }));
  handle('library:playlists', () => ({ items: store!.listPlaylists() }));
  handle('library:presets', () => ({ items: store!.listPresets() }));

  handle('hub:status', () => hub!.getStatus());
  handle('hub:pair-start', (request) => hub!.startPairing((request as { endpoint: string }).endpoint, (request as { code: string }).code));
  handle('hub:pair-await', (request) => hub!.awaitPairing((request as { sessionId: string }).sessionId));
  handle('hub:forget', () => hub!.forget());

  handle('hub:sync-now', async () => {
    const result = await hub!.sync();
    if (result.reason) return { started: false, reason: result.reason };
    notice('info', `Synced: sent ${result.pushed}, received ${result.pulled}${result.conflicts ? `, ${result.conflicts} conflicts resolved` : ''}.`);
    return { started: true, reason: null };
  });

  handle('hub:share-library', (request) => {
    const enabled = (request as { enabled: boolean }).enabled;
    if (enabled && !hub!.hasScope('library:share')) return { enabled: false, reason: 'The hub has not given this companion permission to share its library. Change its permissions in the hub, under Devices.' };
    store!.set('shareLibrary', enabled, new Date().toISOString());
    return { enabled, reason: null };
  });

  handle('transfers:list', () => ({ items: [...transfers.values()] }));

  handle('transfers:send', async (request) => {
    const ids = (request as { trackIds: string[] }).trackIds;
    if (!hub!.getStatus().connected) return { queued: 0, reason: 'No hub is connected.' };
    let queued = 0;
    for (const trackId of ids) {
      const record = store!.findTrack(trackId);
      if (!record) continue;
      const id = uuidv7();
      const progress: TransferProgress = { id, kind: 'upload', trackTitle: record.track.title, bytesDone: 0, bytesTotal: record.sizeBytes, state: 'running', error: null };
      transfers.set(id, progress);
      send('event:transfer-progress', progress);
      queued += 1;
      void hub!
        .uploadTrack(trackId, (bytesDone, bytesTotal) => {
          const updated = { ...transfers.get(id)!, bytesDone, bytesTotal };
          transfers.set(id, updated);
          send('event:transfer-progress', updated);
        })
        .then((result) => {
          const final: TransferProgress = { ...transfers.get(id)!, state: result.ok ? 'completed' : 'failed', error: result.reason };
          transfers.set(id, final);
          send('event:transfer-progress', final);
        });
    }
    return { queued, reason: queued ? null : 'None of those tracks are on this computer any more.' };
  });

  handle('transfers:cancel', (request) => {
    const id = (request as { id: string }).id;
    const existing = transfers.get(id);
    if (!existing) return { ok: false };
    transfers.set(id, { ...existing, state: 'cancelled' });
    send('event:transfer-progress', transfers.get(id)!);
    return { ok: true };
  });

  handle('backup:create', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Save a backup', defaultPath: join(app.getPath('documents'), `now-playing-companion-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { backup: null, reason: null };
    const counts = store!.counts();
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      // Folders are exported by name only: an absolute path is this machine's business, and a
      // backup restored elsewhere would be wrong anyway.
      folders: store!.listFolders(() => true).map((f) => ({ displayName: f.displayName, trackCount: f.trackCount })),
      playlists: store!.listPlaylists(),
      presets: store!.listPresets(),
      counts,
    };
    const text = JSON.stringify(payload, null, 2);
    await writeFile(result.filePath, text, 'utf8');
    return { backup: { path: result.filePath, createdAt: payload.exportedAt, sizeBytes: Buffer.byteLength(text), contents: counts }, reason: null };
  });

  handle('backup:restore', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Choose a backup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths[0]) return { restored: false, reason: null, summary: null };
    try {
      const payload = JSON.parse(await readFile(result.filePaths[0], 'utf8')) as { schemaVersion?: number; playlists?: unknown[]; presets?: unknown[]; exportedAt?: string; counts?: { tracks: number; playlists: number; presets: number; events: number } };
      if (payload.schemaVersion !== 1) return { restored: false, reason: `That backup is version ${payload.schemaVersion ?? 'unknown'}; this app reads version 1.`, summary: null };
      const now = new Date().toISOString();
      for (const playlist of (payload.playlists ?? []) as Array<{ id: string; updatedAt?: string }>) store!.putSynced('playlists', playlist.id, playlist, playlist.updatedAt ?? now, null);
      for (const preset of (payload.presets ?? []) as Array<{ id: string; updatedAt?: string }>) store!.putSynced('eq_presets', preset.id, preset, preset.updatedAt ?? now, null);
      // Folders are not restored: they name paths that may not exist on this machine.
      notice('info', 'Playlists and presets were restored. Music folders are not restored from a backup — add them again, since their locations are specific to each computer.');
      return { restored: true, reason: null, summary: { path: result.filePaths[0], createdAt: payload.exportedAt ?? now, sizeBytes: 0, contents: payload.counts ?? store!.counts() } };
    } catch (err) {
      return { restored: false, reason: `That file could not be read as a backup: ${err instanceof Error ? err.message : String(err)}`, summary: null };
    }
  });

  handle('backup:export-playlists', async () => {
    const playlists = store!.listPlaylists();
    if (!playlists.length) return { path: null, count: 0, reason: 'There are no playlists to export.' };
    const result = await dialog.showSaveDialog(mainWindow!, { title: 'Export playlists', defaultPath: join(app.getPath('documents'), 'playlists.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { path: null, count: 0, reason: null };
    await writeFile(result.filePath, JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), playlists }, null, 2), 'utf8');
    return { path: result.filePath, count: playlists.length, reason: null };
  });

  handle('downloads:list', () => ({ items: [] }));

  handle('downloads:choose-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: 'Where should downloads be saved?', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    const path = result.filePaths[0];
    store!.set(PREFERENCES_KEY, { ...preferences(), downloadDirectory: path }, new Date().toISOString());
    return { path };
  });
}

/* ------------------------------------------------------------------ startup */

if (!enforceSingleInstance(() => showWindow())) {
  app.quit();
} else {
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents, DEV_SERVER_URL));

  // Redirect Electron's own caches and state alongside the database, so a portable build really is
  // self-contained rather than leaving a cache folder behind in the profile.
  {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    app.setPath('sessionData', dir);
  }

  void app.whenReady().then(() => {
    store = new CompanionStore(openCompanionDb(join(dataDir(), 'companion.sqlite')));
    hub = new HubClient(store, `${process.env['COMPUTERNAME'] ?? 'Windows'} companion`, (status) => send('event:hub-status', status));
    applySessionSecurity(session.defaultSession, DEV_SERVER_URL);
    registerHandlers();
    mainWindow = createWindow();
    createTray();
    void hub.refresh();
    if (preferences().autoSync) void hub.sync();
  });

  app.on('window-all-closed', () => {
    // Windows convention: closing the last window quits, unless the tray is holding the app open.
    if (!preferences().minimizeToTray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    scanning?.abort();
    store?.close();
    tray?.destroy();
  });
}
