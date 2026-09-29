/**
 * Final pass §3 — companion <-> hub pairing, in ONE process so the companion stays alive
 * through the whole exchange.
 *
 * Why this rewrite: the two-stage version approved the pairing on the hub after the stage-1
 * Electron had already exited, so the companion never got to call /pairing/complete and nothing
 * was paired. The brief's sequence is followed exactly, just without a process boundary in the
 * middle of it:
 *
 *   1. hub admin creates a pairing session        (what Devices > Pair a device does)
 *   2. a person types address + code into the companion's Remote > Hub connection form
 *   3. the companion shows a verification fingerprint
 *   4. the hub admin confirms that fingerprint    (what the Devices tab's Confirm button does)
 *   5. the companion completes, in-process, and we read what its own screen now says
 *
 * The credential is only ever typed into the companion's UI. Nothing is injected into storage.
 * PORTABLE_EXECUTABLE_DIR=C:\np-final - the owner's real profile is never opened.
 *
 * The hub-side steps (1 and 4) call the same endpoints the Devices tab's buttons call. That is a
 * deliberate, disclosed shortcut: the human decision the tab embodies is unchanged, but it was not
 * clicked in a browser. The report says so.
 */
import { _electron as electron } from '@playwright/test';

// Machine paths come from the environment so no committed file hardcodes the owner's
// username (§5 forbids machine inventories in committed files).
const NP_SCRATCH = process.env.NP_SCRATCH;
const NP_CLONE  = process.env.NP_CLONE;
if (!NP_SCRATCH || !NP_CLONE) { console.error('set NP_SCRATCH and NP_CLONE (see the report)'); process.exit(2); }

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

// The hub's admin password was changed earlier in this pass (first-run requires it) and lives
// ONLY in scratch. My first version hardcoded "admin" and got a 401; that was my bug, not a
// product one. Never commit it, never echo it.
const HUB_PW = readFileSync(`${NP_SCRATCH}/final.pw`, 'utf8').trim();

const EV = '.agents/evidence/final';
const HUB = 'http://127.0.0.1:4546';
const SANDBOX = 'C:\\np-final';
mkdirSync(EV, { recursive: true });

const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 420)); };

// --- hub admin session, held in memory only; nothing is written to disk -------------------
async function hubLogin() {
  const r = await fetch(`${HUB}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: HUB_PW }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  const setCookie = r.headers.get('set-cookie') ?? '';
  const sid = /now-playing-session=([^;]+)/.exec(setCookie)?.[1];
  const csrf = (await r.json()).csrfToken;
  if (!sid || !csrf) throw new Error('no session from login');
  return { sid, csrf };
}
const H = { Cookie: '', 'x-csrf-token': '' };

let app;
try {
  const { sid, csrf } = await hubLogin();
  H.Cookie = `now-playing-session=${sid}`;
  H['x-csrf-token'] = csrf;
  log('hub-session', { ok: true });

  // 1. the admin creates a pairing session on the hub
  const cr = await fetch(`${HUB}/api/v1/pairing/sessions`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKind: 'companion', scopes: ['library:read', 'library:share', 'playlists:sync', 'transfers:receive', 'files:serve'], ttlSeconds: 600 }),
  });
  const created = await cr.json();
  const code = created.code, psid = created.sessionId;
  if (!code || !psid) throw new Error(`pairing session not created: ${JSON.stringify(created).slice(0, 200)}`);
  log('hub-created-session', { sessionId: psid, codeLen: code.length, expiresAt: created.expiresAt });

  // 2. the companion, driven through its own UI
  app = await electron.launch({
    args: ['.'],
    cwd: `${NP_CLONE}/windows-companion`,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX, NODE_ENV: 'development' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);
  log('companion-launched', { title: await win.title() });

  await win.locator('text=Remote').first().click();
  await win.waitForTimeout(900);
  const hubPaneVisible = await win.locator('text=Hub connection').count();
  if (hubPaneVisible) { await win.locator('text=Hub connection').first().click(); await win.waitForTimeout(700); }

  const copy = await win.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 900));
  log('companion-panel-copy', { copy });

  const form = win.locator('.companion-form');
  const inputs = form.locator('input:not([type="checkbox"])');
  const n = await inputs.count();
  log('form-inputs', { count: n });
  await inputs.nth(0).fill(HUB);
  await inputs.nth(1).fill(code);
  const beforeClick = await form.locator('button').evaluateAll((b) => b.map((x) => ({ text: (x.textContent || '').trim().slice(0, 24), disabled: x.disabled })));
  log('typed', { button: beforeClick });
  await form.locator('button').first().click();

  // 3. the companion shows a fingerprint; wait for it
  let fp = null, waited = 0;
  while (waited < 45) {
    fp = await win.evaluate(() => {
      const el = document.querySelector('.companion-fingerprint');
      return el ? el.innerText.trim() : null;
    });
    if (fp) break;
    await win.waitForTimeout(1000); waited++;
  }
  log('challenge', { verificationFingerprint: fp, waitedSeconds: waited });
  if (!fp) throw new Error('companion never showed a verification fingerprint');

  // 4. the hub admin confirms that exact fingerprint
  const cf = await fetch(`${HUB}/api/v1/pairing/sessions/${psid}/confirm`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ verificationFingerprint: fp }),
  });
  log('hub-confirmed', { status: cf.status, body: await cf.text() });

  // 5. the companion completes in-process; read what ITS OWN screen now says
  let connected = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(1000);
    connected = await win.evaluate(() => {
      const t = document.body.innerText.replace(/\s+/g, ' ');
      if (/Waiting for someone at the hub/i.test(t)) return { pending: true };
      const grab = (label) => { const m = t.match(new RegExp(label + ' ([^]{2,140})', 'i')); return m ? m[1].trim() : null; };
      return { pending: false, body: t.slice(0, 700), hub: grab('Hub'), status: grab('Status'), fingerprint: grab('Fingerprint'), may: grab('This computer may'), lastSync: grab('Last sync') };
    });
    if (connected && !connected.pending && connected.status) break;
  }
  log('companion-connected-state', connected);

  // permissions: default off, and does it stick?
  const perms = await win.$$eval('input[type="checkbox"]', (els) =>
    els.map((e) => ({ checked: e.checked, label: (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 90) }))
  );
  log('permissions', { checkboxes: perms });
  await win.screenshot({ path: `${EV}/final-companion-paired.png` });

  // the hub's own view: the device and its scopes
  const dv = await (await fetch(`${HUB}/api/v1/devices`, { headers: { Cookie: H.Cookie } })).json();
  log('hub-devices', { count: dv.items?.length, device: dv.items?.[0] ? { name: dv.items[0].name, kind: dv.items[0].kind, scopes: dv.items[0].scopes, platform: dv.items[0].platform } : null });
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/final-pairing-once.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/final-pairing-once.json`);
  if (app) await app.close().catch(() => {});
}
