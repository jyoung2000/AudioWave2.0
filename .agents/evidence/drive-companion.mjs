/**
 * Drive the REAL Windows companion window with Playwright's Electron support.
 *
 * This is the gap the brief names: `windows-companion` has 30 in-process integration tests and
 * "no launched Electron window has ever been tested". Everything below goes through the shipped
 * main process over IPC, with the real sidecar and the real local-helper.
 *
 * Read-only observation by default. It does not pair, does not change a password, and never
 * prints a credential, a token or a pairing code. The only paths that touch disk are screenshots
 * under .agents/evidence/04-companion/.
 *
 * Run: node .agents/evidence/drive-companion.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'C:/Users/jalon/AudioWave2.0';
const EV = join(REPO, '.agents/evidence/04-companion');
mkdirSync(EV, { recursive: true });

const out = { steps: [], consoleErrors: [], pageErrors: [] };
const step = (name, detail) => {
  out.steps.push({ name, detail });
  console.log(`STEP  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Read a window's visible structure as plain text. No secrets are fetched. */
const readWindow = async (page, label) => {
  const data = await page.evaluate(() => {
    const t = (s) => [...document.querySelectorAll(s)].map((e) => (e.innerText || e.textContent || '').trim()).filter(Boolean);
    return {
      title: document.title,
      headings: t('h1,h2,h3').slice(0, 15),
      buttons: t('button').slice(0, 30),
      inputs: [...document.querySelectorAll('input,select')].map((i) => ({
        id: i.id || null,
        type: i.type || null,
        placeholder: i.placeholder || null,
        aria: i.getAttribute('aria-label') || null,
      })).slice(0, 20),
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
    };
  });
  await page.screenshot({ path: join(EV, `${label}.png`) });
  out[label] = data;
  return data;
};

const app = await electron.launch({
  executablePath: undefined, // use the packaged binary resolved from the electron dep
  args: [join(REPO, 'windows-companion')],
  cwd: join(REPO, 'windows-companion'),
  env: { ...process.env, NODE_ENV: 'development' },
  timeout: 120_000,
});

try {
  step('launched', 'electron window is up');
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  win.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 400)); });
  win.on('pageerror', (e) => out.pageErrors.push(String(e).slice(0, 400)));

  const d = await readWindow(win, '01-initial-window');
  step('initial-window', `title="${d.title}" headings=${JSON.stringify(d.headings.slice(0, 6))}`);

  // How many windows, and is a second one (Settings) reachable? A real user clicks the UI.
  // NOTE: app.windows() is SYNCHRONOUS (returns an array), unlike app.firstWindow().
  const titles = app.windows().map((w) => w.title());
  step('windows', `${titles.length} open: ${JSON.stringify(titles)}`);

  // Report which IPC channels the preload actually exposes — the app's real capability surface,
  // read from the preload's own contract rather than guessed.
  const api = await win.evaluate(() => {
    const k = window.nowPlayingCompanion || window.npCompanion || window.api;
    return k ? Object.keys(k).sort() : null;
  });
  step('preload-api', api ? `${api.length} channels exposed` : 'no preload bridge key found');
  out.preloadApi = api;

  writeFileSync(join(EV, 'companion-window.json'), JSON.stringify(out, null, 2));
  console.log('\nWROTE ' + join(EV, 'companion-window.json'));
  console.log('consoleErrors=' + out.consoleErrors.length + ' pageErrors=' + out.pageErrors.length);
  for (const e of out.consoleErrors.slice(0, 10)) console.log('  console.error: ' + e);
  for (const e of out.pageErrors.slice(0, 10)) console.log('  pageerror: ' + e);
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err);
  console.error('FATAL ' + out.fatal);
  writeFileSync(join(EV, 'companion-window.json'), JSON.stringify(out, null, 2));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
