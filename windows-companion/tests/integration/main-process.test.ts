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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/channels.js';

const dataDir = mkdtempSync(join(tmpdir(), 'np-main-'));
const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
const openedExternally: string[] = [];

vi.mock('electron', () => {
  class FakeWindow {
    webContents = { on: () => undefined, setWindowOpenHandler: () => undefined, send: () => undefined };
    once(_event: string, fn: () => void) {
      fn();
    }
    on() {
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
      on: () => undefined,
      whenReady: () => Promise.resolve(),
      quit: () => undefined,
      getVersion: () => '0.1.0',
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    ipcMain: { handle: (channel: string, fn: (event: unknown, request: unknown) => Promise<unknown>) => handlers.set(channel, fn) },
    Menu: { buildFromTemplate: () => ({}) },
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

async function call(channel: string, request: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, request);
}

beforeAll(async () => {
  await import('../../src/main/index.js');
  // The bootstrap runs inside `app.whenReady().then(...)`; let that microtask settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
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
