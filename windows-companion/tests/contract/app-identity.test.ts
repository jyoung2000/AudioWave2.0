/**
 * The Windows desktop identity: one app id, used by the installer AND by the running process.
 *
 * `pnpm dev:windows` cannot test any of this. It launches the generic
 * `node_modules\electron\dist\electron.exe` against a Vite dev server, so what a user pins is
 * "Electron", and the pin dies with the dev server. The only evidence that counts comes from the
 * packaged build, so these tests cover the two halves that must agree before packaging happens:
 * what electron-builder writes into the shortcuts and registry, and what the main process declares
 * to the shell at runtime.
 *
 * The failure they guard is quiet and reads, from the seat, as "the pin doesn't work": if the
 * runtime call is missing or the strings differ, Windows gives the pinned shortcut and the running
 * window separate taskbar buttons, and toasts are attributed to `electron.app.*` instead of the
 * product. Nothing in the build fails; the app just behaves like two programs.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ID, PRODUCT_NAME } from '../../src/shared/identity.js';

const require = createRequire(import.meta.url);
const companionRoot = join(import.meta.dirname, '..', '..');
// A plain .cjs build config, deliberately dependency-free; loaded the way electron-builder loads it.
const config = require(join(companionRoot, 'electron-builder.config.cjs')) as {
  appId: string;
  productName: string;
  win: { icon: string; target: Array<{ target: string }> };
  nsis: { createStartMenuShortcut: boolean; createDesktopShortcut: boolean; shortcutName: string; perMachine: boolean };
  extraResources: Array<{ from: string; to: string }>;
};

describe('the Windows app identity', () => {
  it('is one stable, reverse-DNS, product-owned id', () => {
    expect(APP_ID).toMatch(/^com\.[a-z0-9.-]+$/);
    // A stable id must not be Electron's default, which is literally the word "electron".
    expect(APP_ID.toLowerCase()).not.toContain('electron');
  });

  it('is the SAME string electron-builder writes into the installer metadata', () => {
    // If these two drift, the installed shortcut and the running window get different taskbar
    // identities and the user sees a second, ungrouped taskbar button.
    expect(config.appId).toBe(APP_ID);
    expect(config.productName).toBe(PRODUCT_NAME);
  });

  it('ships an NSIS installer that creates a Start-menu and desktop shortcut', () => {
    // Pinning is a shell gesture offered against a shortcut. With no shortcut there is nothing to
    // pin, so this is the precondition for the whole feature.
    expect(config.nsis.createStartMenuShortcut).toBe(true);
    expect(config.nsis.createDesktopShortcut).toBe(true);
    expect(config.nsis.shortcutName).toBe(PRODUCT_NAME);
    // Per-user: no administrator rights, so the install cannot be refused for want of privilege.
    expect(config.nsis.perMachine).toBe(false);
    expect(config.win.target.map((t) => t.target)).toContain('nsis');
  });

  it('ships a real multi-size icon, so the pinned button is not Electron’s or a blurred 32px', () => {
    const icon = join(companionRoot, config.win.icon);
    expect(existsSync(icon), `${config.win.icon} must exist for the taskbar button`).toBe(true);
    const ico = readFileSync(icon);
    // ICONDIR: reserved(2) type(2) count(2), then a 16-byte directory entry per frame whose
    // first two bytes are the width and height (0 meaning 256).
    const frames = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < frames; i += 1) {
      sizes.push(ico.readUInt8(6 + 16 * i) || 256);
    }
    expect(sizes, 'the .ico carries 16/32/48/256 so every taskbar size is crisp').toEqual(
      expect.arrayContaining([16, 32, 48, 256]),
    );
  });

  it('bundles the AWSP sidecar that the main process looks for in resources/', () => {
    // findAwspBinary() (src/main/awsp.ts) tries process.resourcesPath first, which only exists in
    // a packaged app. If the binary is not bundled, an installed copy pairs but can never stream,
    // and Settings is the only place that says so.
    const sidecar = config.extraResources.find((r) => r.to === 'awsp-server.exe');
    expect(sidecar, 'extraResources must carry awsp-server.exe next to the app').toBeDefined();
  });
});

describe('the main process declares that identity at runtime', () => {
  const mainSource = readFileSync(join(companionRoot, 'src', 'main', 'index.ts'), 'utf8');

  it('calls setAppUserModelId with the shared constant, not a literal', () => {
    expect(mainSource, 'Electron does not set an AUMID for you').toMatch(/setAppUserModelId\(\s*APP_ID\s*\)/);
    // A hard-coded second copy of the string is exactly the drift this file exists to prevent.
    expect(mainSource).not.toMatch(/setAppUserModelId\(\s*['"]/);
  });

  it('sets the identity before the first window is actually created', () => {
    // Source order is not execution order: `createWindow` (and its `new BrowserWindow`) is DEFINED
    // near the top of this file but only CALLED from the startup block. Asserting on the definition
    // would be a test that passes for the wrong reason, so check the call site instead.
    const declared = mainSource.indexOf('setAppUserModelId');
    const callSite = mainSource.indexOf('mainWindow = createWindow()');
    expect(declared, 'Electron does not set an AUMID for you').toBeGreaterThan(-1);
    expect(callSite, 'the startup block must be the place the first window is created').toBeGreaterThan(-1);
    expect(declared, 'AUMID must be declared before the window is created').toBeLessThan(callSite);
  });

  it('brings an existing window forward when relaunched from the pin', () => {
    // A pinned app whose second launch does nothing reads as a broken pin, which is the complaint
    // that started this. The single-instance lock is only half of it.
    const showWindow = mainSource.slice(mainSource.indexOf('function showWindow'));
    expect(showWindow).toMatch(/mainWindow\.show\(\)/);
    expect(showWindow, 'the second instance must focus, not merely show').toMatch(/mainWindow\.focus\(\)/);
  });
});
