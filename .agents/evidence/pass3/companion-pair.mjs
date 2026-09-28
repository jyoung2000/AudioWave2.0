/**
 * Pass 3 — §3.3 companion <-> hub, driven from the companion's OWN window.
 * Never done by any pass. Done here with Playwright's Electron support so the pairing is
 * performed through Remote > Hub connection, exactly as a person would, not via an API shortcut.
 *
 * Isolation: a SECOND portable profile (C:\np-pass3-pair) so the companion already running for the
 * §2.4 setup-order run is untouched. The pairing code is single-use and short-lived; it is passed
 * into the app at run time and NEVER written to the evidence file.
 */
import { _electron as electron } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const EV = '.agents/evidence/pass3';
mkdirSync(EV, { recursive: true });
const out = { startedAt: new Date().toISOString(), steps: [], notes: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 420)); };

let app, win;
try {
  app = await electron.launch({
    args: ['.'],
    cwd: 'C:/Users/jalon/AudioWave2.0-pass3/windows-companion',
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: 'C:\\np-pass3-pair', NODE_ENV: 'development' },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);
  log('launched', { title: await win.title(), hasWindow: true });

  // Find the Remote section. The nav is a list of {id,label} panes; Remote is id 'remote'.
  const nav = await win.$$eval('nav *, [role="tab"], button, li, a', (els) =>
    els.slice(0, 200).map((e) => (e.textContent || '').trim()).filter((t) => t && t.length < 40)
  );
  const uniq = [...new Set(nav)].slice(0, 40);
  log('nav', { labels: uniq });

  // Click Remote.
  const remote = win.locator('text=Remote').first();
  if (await remote.count()) { await remote.click(); await win.waitForTimeout(1200); }
  await win.screenshot({ path: `${EV}/p3e-companion-remote.png` });

  // What does the Hub connection pane actually ask for?
  const fields = await win.$$eval('input, select, button, label', (els) =>
    els.map((e) => ({
      tag: e.tagName, type: e.getAttribute('type'), id: e.id || null,
      name: e.getAttribute('name'), ph: e.getAttribute('placeholder'),
      text: (e.textContent || '').trim().slice(0, 44), aria: e.getAttribute('aria-label'),
    })).filter((f) => f.text || f.ph || f.id || f.aria)
  );
  log('hub-pane-fields', { fields });
  const body = await win.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 900));
  log('hub-pane-text', { body });
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 5).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/p3e-companion-hub-probe.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3e-companion-hub-probe.json`);
  if (app) await app.close().catch(() => {});
}
