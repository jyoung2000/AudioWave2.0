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

  it('ships the AWSP sidecar that the main process looks for in resources/', () => {
    // findAwspBinary() (src/main/awsp.ts) tries process.resourcesPath first, which only exists in
    // a packaged app. If the binary is not bundled, an installed copy pairs but can never stream,
    // and Settings is the only place that says so.
    const sidecar = config.extraResources.find((r) => r.to === 'awsp-server.exe');
    expect(sidecar, 'extraResources must carry awsp-server.exe next to the app').toBeDefined();
  });

  it('declares an author, so CompanyName is not Electron’s default', () => {
    // Without `author`, electron-builder warns ("author is missed in the package.json") and writes
    // CompanyName "GitHub, Inc." — Electron's own fallback — into the binary. That string shows in
    // file Properties, in Add/Remove Programs and in any security prompt, so an installed app
    // claiming to be a GitHub product is not a cosmetic detail.
    const pkg = JSON.parse(readFileSync(join(companionRoot, 'package.json'), 'utf8')) as { author?: { name?: string } };
    expect(pkg.author?.name, 'package.json must name an author').toBeTruthy();
    expect(pkg.author?.name?.toLowerCase(), 'CompanyName must not be Electron’s default').not.toContain('github');
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

/**
 * The window's own chrome: no File / Edit / View / Window bar.
 *
 * These two apps are full of text fields — a pairing code, a hub address, a search box, a right
 * click for context. Electron's default application menu sits above all of it offering entries
 * that do nothing useful here (no File > Open, no Window > Minimize) and, worse, its accelerators
 * are not wired to anything the app owns. Removing it is what makes the window read as a program
 * rather than a browser frame that happens to have a title.
 *
 * `autoHideMenuBar` is NOT the fix: it hides the bar until the user presses Alt, so the menu
 * still exists and still appears. `setApplicationMenu(null)` removes it.
 */
describe('the window has no default application menu', () => {
  const mainSource = readFileSync(join(companionRoot, 'src', 'main', 'index.ts'), 'utf8');

  it('removes the application menu rather than auto-hiding it', () => {
    expect(mainSource).toMatch(/Menu\.setApplicationMenu\(\s*null\s*\)/);
    // autoHideMenuBar only defers the menu to Alt; it leaves it there.
    expect(mainSource, 'autoHideMenuBar still reveals the menu on Alt').not.toMatch(/autoHideMenuBar/);
  });

  it('does it before the first window is created, so the bar never flashes in', () => {
    // A window's menu is fixed when it is constructed, so a later call would not clear the one
    // already built. This is also why it must not be deferred into whenReady().
    const removed = mainSource.indexOf('setApplicationMenu');
    const callSite = mainSource.indexOf('mainWindow = createWindow()');
    expect(removed).toBeGreaterThan(-1);
    expect(removed, 'the menu must go before the window exists').toBeLessThan(callSite);
  });

  it('leaves the tray menu alone — Open, Scan and Quit must survive', () => {
    // Menu is still imported and still used: the tray context menu is a different object, built
    // with buildFromTemplate. Clearing the application menu must not touch it, and dropping the
    // import would break it.
    expect(mainSource, 'the tray menu is a separate object and must still be built').toMatch(/Menu\.buildFromTemplate\(/);
    expect(mainSource, 'tray.setContextMenu must remain').toMatch(/tray\.setContextMenu\(/);
    for (const label of ['Open', 'Scan Library Now', 'Quit']) {
      expect(mainSource, `the tray keeps "${label}"`).toContain(`label: '${label}'`);
    }
  });
});

/**
 * The title bar is the design's, and the window is still Windows'.
 *
 * `design/frontends/origin/airwave-companion.html` draws the title and the four tools on one sheet of
 * chrome with nothing above it. A second, operating-system title bar over that — the same name
 * twice — was the most visible way the app differed from its design. So the OS title bar is hidden
 * and the page draws the title. What must not be lost in doing that is everything Windows users
 * expect of a window: real minimise / maximise / close buttons where they always are, Snap Layouts
 * on the maximise button, dragging by the title, resizing by the edges. `titleBarOverlay` keeps all
 * of it; `frame: false` would throw it away.
 */
describe('the title bar is the page’s chrome, with Windows’ own buttons over it', () => {
  const mainSource = readFileSync(join(companionRoot, 'src', 'main', 'index.ts'), 'utf8');
  const rendererDir = join(companionRoot, 'src', 'renderer');
  const styles = readFileSync(join(rendererDir, 'styles.css'), 'utf8');
  const appSource = readFileSync(join(rendererDir, 'App.tsx'), 'utf8');

  it('hides the OS title bar but never the frame', () => {
    expect(mainSource).toMatch(/titleBarStyle:\s*'hidden'/);
    expect(mainSource, 'a frameless window loses Snap, resizing and the native buttons').not.toMatch(/frame:\s*false/);
  });

  it('asks Windows to draw its buttons over the chrome, at the height of the design’s title strip', () => {
    expect(mainSource).toMatch(/titleBarOverlay:\s*\{[^}]*height:\s*TITLE_BAR_HEIGHT[^}]*\}/);
    expect(mainSource).toMatch(/const TITLE_BAR_HEIGHT = 26;/);
    // The design's `.titlebar` is 26px tall; the overlay and the strip must be the same strip.
    const sheet = readFileSync(join(companionRoot, '..', 'packages', 'aqua-ui', 'src', 'styles', 'airwave-window.css'), 'utf8');
    expect(/\.titlebar\s*\{[^}]*height:\s*26px/.test(sheet), 'the design’s title strip is 26px').toBe(true);
  });

  it('names the window once, from the shared constant', () => {
    expect(mainSource).toMatch(/title:\s*PRODUCT_NAME/);
    expect(mainSource).toMatch(/tray\.setToolTip\(PRODUCT_NAME\)/);
    expect(appSource).toMatch(/PRODUCT_NAME/);
    // The page's own <title> is what Windows shows in the taskbar and Alt+Tab.
    const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(PRODUCT_NAME);
    for (const source of [mainSource, appSource, html]) expect(source).not.toContain('Now Playing Companion');
  });

  it('makes the chrome the drag region and leaves the tools clickable', () => {
    expect(styles).toMatch(/\.chrome\s*\{[^}]*-webkit-app-region:\s*drag/);
    expect(styles).toMatch(/\.tool\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    // The window fills its frame: no desktop backdrop, no margin, no second outline.
    expect(styles).toMatch(/body\s*\{[^}]*padding:\s*0/);
    expect(styles).toMatch(/\.win\s*\{[^}]*border:\s*0/);
  });

  it('wears the design’s stylesheet, not a copy of it', () => {
    const main = readFileSync(join(rendererDir, 'main.tsx'), 'utf8');
    expect(main).toContain("import '@now-playing/aqua-ui/airwave-window.css'");
    expect(main).toMatch(/installAquaArt\(\)/);
  });
});
