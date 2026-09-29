/**
 * Final pass §3, part 2 — folder watch, sharing permission stickiness, and hub-side library follow.
 *
 * Pairing is proven; these are the core gates that follow from it:
 *   1. add the watched folder through the companion's own Folders UI
 *   2. tick "Let the hub see what music is on this computer" and prove the change is OBSERVED
 *      (not just stored) - the hub's device record must change
 *   3. trigger a scan and read the hub's library to see the folder's contents follow
 *   4. rename a file in MY sandbox folder and see the hub follow the rename
 *
 * The sandbox folder C:\np-final\music is mine; the owner's corpus is only ever read.
 */
import { _electron as electron } from '@playwright/test';
import { writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';

const EV = '.agents/evidence/final';
const SANDBOX = 'C:\\np-final';
const FOLDER = 'C:\\np-final\\music';
const HUB = 'http://127.0.0.1:4546';
const HUB_PW = (await import('node:fs')).readFileSync('C:/Users/jalon/AppData/Local/hermes/cache/scratch/final.pw', 'utf8').trim();
mkdirSync(EV, { recursive: true });

const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 460)); };

async function hubSession() {
  const r = await fetch(`${HUB}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: HUB_PW }),
  });
  const sid = /now-playing-session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1];
  const csrf = (await r.json()).csrfToken;
  return { Cookie: `now-playing-session=${sid}`, 'x-csrf-token': csrf };
}
const H = await hubSession();

let app;
try {
  const before = readdirSync(FOLDER);
  log('folder-before', { files: before });

  app = await electron.launch({
    args: ['.'],
    cwd: 'C:/Users/jalon/AudioWave2.0-final/windows-companion',
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX, NODE_ENV: 'development' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3500);

  // ---- 1. Folders tab: add the folder through the UI ----
  await win.locator('text=Folders').first().click();
  await win.waitForTimeout(1200);
  const folderCopy = await win.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700));
  log('folders-tab', { copy: folderCopy });
  await win.screenshot({ path: `${EV}/final-folders-before.png` });

  const addBtn = win.locator('button').filter({ hasText: /add (a |the )?folder|choose|browse/i }).first();
  if (await addBtn.count()) {
    // Electron folder pickers are native; the app usually also accepts a typed path.
    log('add-folder-button', { found: true, text: (await addBtn.textContent())?.trim().slice(0, 40) });
  } else {
    log('add-folder-button', { found: false });
  }

  // Is there a text field for a path (the scriptable route through the same UI)?
  const pathInputs = await win.$$eval('input', (els) =>
    els.map((e) => ({ type: e.getAttribute('type'), value: e.value, ph: e.getAttribute('placeholder') })));
  log('folder-inputs', { inputs: pathInputs });

  // ---- 2. permissions: does a tick OBSERVE on the hub? ----
  // Click the LABEL, not the input: aqua-check__input is visually hidden and a direct .click() on
  // it times out. The label is what a person actually clicks.
  await win.locator('text=Remote').first().click();
  await win.waitForTimeout(1200);
  await win.locator('text=Hub connection').first().click().catch(() => {});
  await win.waitForTimeout(1500);
  const shareRow = win.locator('.companion-list, label').filter({ hasText: 'Let the hub see what music' }).first();
  const shareLabel = win.locator('label').filter({ hasText: 'Let the hub see what music' }).first();
  const target = (await shareLabel.count()) ? shareLabel : shareRow;
  const preChecked = await win.evaluate(() => {
    const labels = [...document.querySelectorAll('label')];
    const l = labels.find((x) => /Let the hub see what music/i.test(x.textContent || ''));
    const input = l?.querySelector('input[type="checkbox"]') || (l && l.htmlFor ? document.getElementById(l.htmlFor) : null);
    return input ? input.checked : null;
  });
  await target.click({ force: true });
  await win.waitForTimeout(3000);
  const postChecked = await win.evaluate(() => {
    const labels = [...document.querySelectorAll('label')];
    const l = labels.find((x) => /Let the hub see what music/i.test(x.textContent || ''));
    const input = l?.querySelector('input[type="checkbox"]') || (l && l.htmlFor ? document.getElementById(l.htmlFor) : null);
    return input ? input.checked : null;
  });
  log('share-tick', { before: preChecked, after: postChecked });

  // The hub's own view: did the companion's change arrive there?
  const dev = await (await fetch(`${HUB}/api/v1/devices`, { headers: { Cookie: H.Cookie } })).json();
  log('hub-device-after-tick', {
    count: dev.items?.length,
    first: dev.items?.[0] ? { name: dev.items[0].name, libraryVisible: dev.items[0].libraryVisible ?? dev.items[0].shareLibrary ?? null, scopes: dev.items[0].scopes } : null,
    rawKeys: dev.items?.[0] ? Object.keys(dev.items[0]).slice(0, 24) : [],
  });
  await win.screenshot({ path: `${EV}/final-hub-shared.png` });

  // ---- 3. hub library: does the folder's content follow? ----
  const lib = await (await fetch(`${HUB}/api/v1/library?limit=50`, { headers: { Cookie: H.Cookie } })).json().catch(() => null);
  log('hub-library', { ok: !!lib, count: lib?.items?.length ?? lib?.tracks?.length ?? null, sample: (lib?.items ?? lib?.tracks ?? []).slice(0, 6).map((x) => x.title ?? x.name) });

  // ---- 4. rename in MY sandbox folder, then ask the hub again ----
  const renameFrom = `${FOLDER}\\01_kick_120bpm.flac`;
  const renameTo = `${FOLDER}\\renamed_probe_120bpm.flac`;
  try { renameSync(renameFrom, renameTo); log('renamed-in-sandbox', { from: renameFrom.split('\\').pop(), to: renameTo.split('\\').pop() }); }
  catch (e) { log('rename-failed', { error: String(e).slice(0, 120) }); }
  await win.waitForTimeout(1500);
  const syncBtn = win.locator('button').filter({ hasText: /sync now|^sync$/i }).first();
  if (await syncBtn.count()) { await syncBtn.click(); await win.waitForTimeout(4000); log('sync-clicked', {}); }
  const lib2 = await (await fetch(`${HUB}/api/v1/library?limit=50`, { headers: { Cookie: H.Cookie } })).json().catch(() => null);
  log('hub-library-after-rename', { count: lib2?.items?.length ?? lib2?.tracks?.length ?? null, sample: (lib2?.items ?? lib2?.tracks ?? []).slice(0, 6).map((x) => x.title ?? x.name) });
  await win.screenshot({ path: `${EV}/final-hub-library.png` });
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/final-folder-watch.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/final-folder-watch.json`);
  if (app) await app.close().catch(() => {});
}
