/* eslint-disable no-console -- stdout IS the evidence record for these CLI reporters. */
/**
 * Verify the INSTALLED companion: the File/Edit/View/Window menu is really gone.
 *
 * A source-text assertion (`Menu.setApplicationMenu(null)` appears in index.ts) proves intent, not
 * behaviour. The menu is created by Electron in the main process, and the only way to observe it
 * truthfully is to ask a live main process. This launches the INSTALLED executable — not
 * `pnpm dev:windows`, which runs the generic `node_modules\electron\dist\electron.exe` and is a
 * different program as far as Windows is concerned — and queries the real objects:
 *
 *   Menu.getApplicationMenu()   -> null  means no application menu exists at all
 *   win.isMenuBarVisible()       -> false means the bar is not drawn in the window
 *   win.isMenuBarAutoHide()      -> false means Alt will not bring a hidden bar back
 *
 * `app.evaluate` runs in the main process, so this is the app's own truth, not an observation from
 * outside. Read-only: it changes nothing, and it deliberately does not touch pairing or settings.
 *
 * Run: node .agents/evidence/verify-installed-menu.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Now Playing Companion', 'Now Playing Companion.exe');
const EV = 'C:/Users/jalon/AudioWave2.0/.agents/evidence/05-installer';
mkdirSync(EV, { recursive: true });

const report = { installedExe: INSTALLED, checks: [], errors: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ executablePath: INSTALLED, args: [], timeout: 120_000 });
try {
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const state = await app.evaluate(async ({ Menu, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0] ?? null;
    const menu = Menu.getApplicationMenu();
    return {
      applicationMenuIsNull: menu === null,
      menuItemCount: menu ? menu.items.length : 0,
      menuLabels: menu ? menu.items.map((i) => i.label) : [],
      isMenuBarVisible: w ? w.isMenuBarVisible() : null,
      isMenuBarAutoHide: w ? w.isMenuBarAutoHide() : null,
      windowCount: BrowserWindow.getAllWindows().length,
      title: w ? w.getTitle() : null,
    };
  });

  report.state = state;
  console.log('\nmain-process state:', JSON.stringify(state, null, 2));

  check('no application menu exists (Menu.getApplicationMenu() === null)', state.applicationMenuIsNull, `${state.menuItemCount} top-level items`);
  check('the File/Edit/View/Window bar is not drawn', state.isMenuBarVisible === false, `isMenuBarVisible=${state.isMenuBarVisible}`);
  check('Alt does not reveal a hidden bar', state.isMenuBarAutoHide === false, `isMenuBarAutoHide=${state.isMenuBarAutoHide}`);
  check('window title is the product, never "Electron"', state.title === 'Now Playing Companion', `title="${state.title}"`);

  writeFileSync(join(EV, 'installed-menu-check.json'), JSON.stringify(report, null, 2));
  console.log(`\nWROTE ${join(EV, 'installed-menu-check.json')}`);
  process.exitCode = report.checks.every((c) => c.pass) ? 0 : 1;
} catch (err) {
  report.errors.push(String(err?.stack ?? err));
  console.error('FATAL ' + report.errors[0]);
  writeFileSync(join(EV, 'installed-menu-check.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
