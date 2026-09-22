/**
 * The main process, booted.
 *
 * Electron itself is stubbed — there is no window and no display — but everything else is real:
 * the SQLite database is created on disk, the IPC handlers are the actual ones, and each request
 * and response goes through the same validation the packaged app uses. What this proves is the
 * part unit tests keep missing: that the app *starts*, that every channel the renderer can call
 * has a handler behind it, and that a malformed request is refused at the boundary rather than
 * reaching the filesystem.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/channels.js';

const dataDir = mkdtempSync(join(tmpdir(), 'np-main-'));
const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
const appEvents = new Map<string, Array<(...args: unknown[]) => void>>();
const windowEvents = new Map<string, Array<(event: { preventDefault: () => void }) => void>>();
const openedExternally: string[] = [];
/** What the next open-file dialog returns; null means the person cancelled. */
const dialogPick: { path: string | null } = { path: null };

/** The page the packaged app loads; the main process answers IPC only from this URL. */
const APP_PAGE = pathToFileURL(fileURLToPath(new URL('../../src/renderer/index.html', import.meta.url))).href;

vi.mock('electron', () => {
  class FakeWindow {
    webContents = { on: () => undefined, setWindowOpenHandler: () => undefined, send: () => undefined };
    once(_event: string, fn: () => void) {
      fn();
    }
    on(event: string, fn: (event: { preventDefault: () => void }) => void) {
      windowEvents.set(event, [...(windowEvents.get(event) ?? []), fn]);
      return this;
    }
    loadURL() {}
    loadFile() {}
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    show() {}
    focus() {}
    restore() {}
    hide() {}
  }
  return {
    app: {
      getPath: (key: string) => (key === 'userData' ? dataDir : tmpdir()),
      setPath: () => undefined,
      requestSingleInstanceLock: () => true,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        appEvents.set(event, [...(appEvents.get(event) ?? []), fn]);
      },
      whenReady: () => Promise.resolve(),
      quit: () => undefined,
      getVersion: () => '0.1.0',
      setLoginItemSettings: () => undefined,
    },
    BrowserWindow: FakeWindow,
    dialog: {
      showOpenDialog: async () => (dialogPick.path ? { canceled: false, filePaths: [dialogPick.path] } : { canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    ipcMain: { handle: (channel: string, fn: (event: unknown, request: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
    Menu: { buildFromTemplate: () => ({}) },
    powerMonitor: { on: () => undefined },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from([...Buffer.from(text, 'utf8')].reverse()),
      decryptString: (data: Buffer) => Buffer.from([...data].reverse()).toString('utf8'),
    },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined }, setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined, setDevicePermissionHandler: () => undefined } },
    shell: {
      openExternal: async (url: string) => {
        openedExternally.push(url);
      },
      showItemInFolder: () => undefined,
    },
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    nativeImage: { createFromPath: () => ({}), createEmpty: () => ({}) },
  };
});

async function call(channel: string, request: unknown, senderUrl: string | null = APP_PAGE): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({ senderFrame: senderUrl === null ? null : { url: senderUrl } }, request);
}

function emitApp(event: string): void {
  for (const fn of appEvents.get(event) ?? []) fn({ preventDefault: () => undefined });
}

beforeAll(async () => {
  await import('../../src/main/index.js');
  // The bootstrap runs inside `app.whenReady().then(...)`; let that microtask settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(() => {
  // Quitting closes the database; Windows refuses to delete a file that is still open.
  emitApp('before-quit');
  emitApp('will-quit');
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('startup', () => {
  it('registers a handler for every channel the preload will forward', () => {
    expect([...handlers.keys()].sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it('creates its database in the application data directory', async () => {
    const info = (await call('app:info', undefined)) as { dataDir: string; contractsVersion: string; protocolVersion: number };
    expect(info.dataDir).toBe(dataDir);
    expect(info.contractsVersion).toBeTruthy();
    expect(info.protocolVersion).toBeGreaterThan(0);
  });

  it('reports an unsigned build as unsigned', async () => {
    const info = (await call('app:info', undefined)) as { signed: boolean };
    expect(info.signed).toBe(false);
  });

  it('starts with no folders and no hub, and says so rather than showing nothing', async () => {
    expect(await call('library:folders', undefined)).toEqual({ items: [] });
    const status = (await call('hub:status', undefined)) as { connected: boolean; reason: string };
    expect(status.connected).toBe(false);
    expect(status.reason).toBe('No hub is paired.');
  });
});

describe('the boundary validates both directions', () => {
  it('refuses a request that does not match the channel’s schema', async () => {
    await expect(call('library:tracks', { limit: 99_999, offset: 0 })).rejects.toThrow();
    await expect(call('library:remove-folder', { folderId: 'not-a-uuid' })).rejects.toThrow();
    await expect(call('app:open-external', { url: 'nonsense' })).rejects.toThrow();
  });

  it('accepts a request that does match', async () => {
    await expect(call('library:tracks', { limit: 10, offset: 0 })).resolves.toMatchObject({ items: [], total: 0 });
  });

  it('answers only the app’s own page, not another local file or a missing frame', async () => {
    await expect(call('app:info', undefined, 'file:///C:/Users/Sam/Downloads/evil.html')).rejects.toThrow(/not this app/);
    await expect(call('app:info', undefined, 'https://example.com/')).rejects.toThrow(/not this app/);
    await expect(call('app:info', undefined, null)).rejects.toThrow(/not this app/);
  });
});

describe('preferences', () => {
  it('changes only the preference that was sent', async () => {
    await call('app:preferences:set', { minimizeToTray: false, theme: 'light' });
    const next = (await call('app:preferences:set', { autoSync: true })) as Record<string, unknown>;
    expect(next).toMatchObject({ autoSync: true, minimizeToTray: false, theme: 'light' });
    expect(await call('app:preferences:get', undefined)).toMatchObject({ autoSync: true, minimizeToTray: false, theme: 'light' });
    await call('app:preferences:set', { minimizeToTray: true, autoSync: false });
  });

  it('refuses a preference the main process never agreed to, such as a filesystem path', async () => {
    // `strict`: an unknown key is rejected, not quietly dropped. That is what stops a renderer from
    // introducing a preference — a write path among them — the main process does not know about.
    // The companion does not download anything, so it no longer has a download directory at all.
    await expect(call('app:preferences:set', { downloadDirectory: 'C:\\Windows\\System32' })).rejects.toThrow();
    expect(await call('app:preferences:get', undefined)).not.toHaveProperty('downloadDirectory');
  });
});

describe('links', () => {
  it('opens a web link in the real browser', async () => {
    openedExternally.length = 0;
    await expect(call('app:open-external', { url: 'https://example.com/docs' })).resolves.toEqual({ opened: true, reason: null });
    expect(openedExternally).toEqual(['https://example.com/docs']);
  });

  it('refuses a scheme that could start a program, and never reaches the shell', async () => {
    openedExternally.length = 0;
    const result = (await call('app:open-external', { url: 'file:///C:/Windows/System32/cmd.exe' })) as { opened: boolean; reason: string };
    expect(result.opened).toBe(false);
    expect(result.reason).toMatch(/start a program/);
    expect(openedExternally).toEqual([]);
  });
});

describe('revealing a file', () => {
  it('refuses a track it does not have, rather than guessing a path', async () => {
    const result = (await call('app:reveal', { trackId: '00000000-0000-7000-8000-000000000000' })) as { ok: boolean; reason: string | null };
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('transfers', () => {
  it('refuses to cancel a transfer it does not know', async () => {
    await expect(call('transfers:cancel', { id: 'nope' })).resolves.toEqual({ ok: false });
  });
});

describe('the embedded helper and the backup channels', () => {
  it('starts the helper on the preferred port and answers its health route', async () => {
    const status = (await call('helper:status', undefined)) as { running: boolean; origin: string | null; reason: string | null; tools: Array<{ id: string; present: boolean }> };
    expect(status.running, status.reason ?? '').toBe(true);
    const health = await fetch(`${status.origin}/helper/v1/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { helper: string }).helper).toBe('now-playing-local-helper');
    expect(status.tools.map((t) => t.id)).toEqual(['yt-dlp', 'spotdl', 'ffmpeg']);
    const token = (await call('helper:token', undefined)) as { token: string | null };
    expect(token.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The same token every time: a player that pasted it once keeps working.
    expect(await call('helper:token', undefined)).toEqual(token);
  });

  it('has no backup folder until one is chosen, and says so instead of guessing', async () => {
    expect(await call('backup:settings:get', undefined)).toMatchObject({ dir: null, schedule: 'manual', keep: 5 });
    const estimate = (await call('backup:estimate', undefined)) as { blocked: string | null };
    expect(estimate.blocked).toBe('Choose where backups go first.');
    expect(await call('backup:list', undefined)).toEqual({ items: [] });
    expect(await call('backup:create', undefined)).toEqual({ backup: null, reason: 'Choose where backups go first.' });
    // A cancelled folder picker changes nothing.
    dialogPick.path = null;
    expect(await call('backup:pick-dir', undefined)).toMatchObject({ settings: { dir: null }, reason: null });
  });

  it('refuses a setting the contract does not know, and keeps the rest', async () => {
    await expect(call('backup:settings:set', { keep: 4 })).rejects.toThrow(/keep/);
    await expect(call('backup:settings:set', { dir: 'C:\\anywhere' })).rejects.toThrow();
    expect(await call('backup:settings:set', { include: { tv: true }, keep: 3 })).toMatchObject({ include: { tv: true, music: true }, keep: 3 });
  });
});

describe('backup restore', () => {
  it('does nothing when the person cancels the file picker', async () => {
    dialogPick.path = null;
    await expect(call('backup:restore', undefined)).resolves.toEqual({ restored: false, reason: null, summary: null });
  });

  const now = new Date().toISOString();
  const goodPlaylist = { id: '01920000-0000-7000-8000-000000000001', createdAt: now, updatedAt: now, name: 'Road Trip' };

  it('rejects a backup with a malformed playlist and writes nothing, so the playlist list keeps working', async () => {
    const file = join(dataDir, 'bad-backup.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, playlists: [goodPlaylist, { id: 'not-a-uuid', name: '' }], presets: [] }));
    dialogPick.path = file;
    const result = (await call('backup:restore', undefined)) as { restored: boolean; reason: string | null };
    expect(result.restored).toBe(false);
    expect(result.reason).toMatch(/nothing was restored/);
    // Neither the good nor the bad playlist was written, and the channel still answers.
    await expect(call('library:playlists', undefined)).resolves.toEqual({ items: [] });
  });

  it('restores a valid backup', async () => {
    const file = join(dataDir, 'good-backup.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, exportedAt: now, playlists: [goodPlaylist], presets: [] }));
    dialogPick.path = file;
    const result = (await call('backup:restore', undefined)) as { restored: boolean; reason: string | null };
    expect(result).toMatchObject({ restored: true, reason: null });
    const listed = (await call('library:playlists', undefined)) as { items: Array<{ name: string }> };
    expect(listed.items.map((p) => p.name)).toEqual(['Road Trip']);
    dialogPick.path = null;
  });
});

describe('quitting', () => {
  it('lets the window close after the database has been closed', () => {
    const closeHandlers = windowEvents.get('close') ?? [];
    expect(closeHandlers.length).toBeGreaterThan(0);
    emitApp('before-quit');
    emitApp('will-quit');
    let prevented = false;
    // Before the fix this read preferences from the closed database and threw.
    expect(() => {
      for (const fn of closeHandlers) fn({ preventDefault: () => (prevented = true) });
    }).not.toThrow();
    expect(prevented).toBe(false);
  });
});
