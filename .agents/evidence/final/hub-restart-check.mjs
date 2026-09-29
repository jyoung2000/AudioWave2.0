/**
 * Final pass §3 — after the pairing, prove the CREDENTIAL SURVIVES A RESTART by reading the
 * companion's own Hub connection panel on a fresh launch, and set up the watched folder.
 *
 * The first pairing attempt's connected-state read was inconclusive: the script read the window
 * body while the app was showing the Stream tab. This one navigates Remote > Hub connection first
 * and reads the KeyValueList rows the component actually renders (Hub.tsx:29-39).
 */
import { _electron as electron } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const EV = '.agents/evidence/final';
const SANDBOX = 'C:\\np-final';
const FOLDER = 'C:\\np-final\\music';
mkdirSync(EV, { recursive: true });

const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 500)); };

let app;
try {
  // Record the watched folder's contents BEFORE the companion is told about it.
  const before = readdirSync(FOLDER);
  log('folder-before', { folder: FOLDER, files: before });

  app = await electron.launch({
    args: ['.'],
    cwd: 'C:/Users/jalon/AudioWave2.0-final/windows-companion',
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX, NODE_ENV: 'development' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3500);
  log('relaunched', { title: await win.title() });

  await win.locator('text=Remote').first().click();
  await win.waitForTimeout(1200);
  if (await win.locator('text=Hub connection').count()) {
    await win.locator('text=Hub connection').first().click();
    await win.waitForTimeout(1500);
  }
  await win.screenshot({ path: `${EV}/final-hub-after-restart.png` });

  // The component renders a KeyValueList; read its rows by their keys.
  const hubState = await win.evaluate(() => {
    const rows = {};
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (/^(Hub|Status|Fingerprint|This computer may|Last sync)$/.test(t)) {
        const sib = el.nextElementSibling;
        if (sib) rows[t] = (sib.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      }
    }
    return {
      rows,
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
      isConnectedView: !/Connect to a hub/i.test(document.body.innerText),
      seesForgetButton: /Forget this hub/i.test(document.body.innerText),
      seesShareCheckbox: /Let the hub see what music is on this computer/i.test(document.body.innerText),
    };
  });
  log('hub-state-after-restart', hubState);

  const checkboxes = await win.$$eval('input[type="checkbox"]', (els) =>
    els.map((e) => ({ checked: e.checked, label: (e.labels?.[0]?.innerText || '').trim().slice(0, 80) }))
  );
  log('permissions-after-restart', { checkboxes });
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/final-hub-restart.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/final-hub-restart.json`);
  if (app) await app.close().catch(() => {});
}
