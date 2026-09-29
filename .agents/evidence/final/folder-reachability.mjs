/**
 * Final pass, follow-up — can the companion's OWN store be reached without the native picker?
 *
 * My report called folder-watch NOT DONE because "Add Folder..." opens a native
 * dialog.showOpenDialog, which Playwright cannot drive. Before accepting that, check the code:
 * index.ts:397 shows the IPC handler calls the picker and then store!.addFolder(folder) - so the
 * PERSISTENCE path is the product's own code, and only the picker sits in front of it.
 *
 * This is the same reasoning already used (and disclosed) for the hub-side pairing calls: reaching
 * the product's own handler is not a synthetic shortcut, and the gap it leaves is the native
 * dialog, which I will still report as untested.
 *
 * If the store is reachable, folder propagation, tempo and the hub-side library become testable.
 * If it is not, the NOT DONE stands on firmer ground for having been checked rather than assumed.
 */
import { _electron as electron } from '@playwright/test';

// Machine paths come from the environment so no committed file hardcodes the owner's
// username (§5 forbids machine inventories in committed files).
const NP_SCRATCH = process.env.NP_SCRATCH;
const NP_CLONE  = process.env.NP_CLONE;
if (!NP_SCRATCH || !NP_CLONE) { console.error('set NP_SCRATCH and NP_CLONE (see the report)'); process.exit(2); }

import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';

const EV = '.agents/evidence/final';
const SANDBOX = 'C:\\np-final';
const FOLDER = 'C:\\np-final\\music';
const HUB = 'http://127.0.0.1:4544';
mkdirSync(EV, { recursive: true });

const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 500)); };

let app;
try {
  log('folder-contents', { files: readdirSync(FOLDER) });

  app = await electron.launch({
    args: ['.'],
    cwd: `${NP_CLONE}/windows-companion`,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX, NODE_ENV: 'development' },
  });
  await app.firstWindow();
  await new Promise((r) => setTimeout(r, 3000));

  // What does the MAIN process expose? Look for the store the picker feeds.
  const probe = await app.evaluate(async () => {
    const g = globalThis;
    const keys = Object.keys(g).filter((k) => /store|companion|np|db|state/i.test(k));
    return {
      globalKeys: keys.slice(0, 30),
      hasStore: typeof g.store,
      storeKeys: g.store ? Object.keys(g.store).slice(0, 25) : null,
      typeofAddFolder: g.store ? typeof g.store.addFolder : null,
      hasIpc: typeof g.ipcMain,
    };
  });
  log('main-process-probe', probe);

  // If the store is reachable, add the folder through the product's own function.
  if (probe && typeofAddFolder === 'function') {
    const added = await app.evaluate(async (folder) => {
      try {
        globalThis.store.addFolder({ id: 'probe-folder', path: folder, displayName: 'np-final music', kind: 'music', now: new Date().toISOString() });
        const rows = typeof globalThis.store.folders === 'function' ? await globalThis.store.folders() : null;
        return { ok: true, folders: rows };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200) };
      }
    }, FOLDER);
    log('store-add-folder', added);
  } else {
    log('store-add-folder', { skipped: 'store.addFolder is not reachable from the main process global' });
  }
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/final-folder-reachability.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/final-folder-reachability.json`);
  if (app) await app.close().catch(() => {});
}
