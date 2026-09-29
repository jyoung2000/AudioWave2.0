/**
 * Final pass — §3 companion <-> hub pairing, driven through the companion's OWN UI.
 *
 * Release gate, never done by any pass. Requirements honoured here:
 *  - PORTABLE_EXECUTABLE_DIR=C:\np-final (APPDATA does not move an Electron profile on Windows).
 *  - The credential is created and approved in the HUB's UI by a human step; this script only ever
 *    types what a person types. It never calls the pairing API to inject a credential.
 *  - One companion only. Do NOT also run `pnpm dev:windows` - that would collide on 17342.
 *
 * Two stages, because approval is a human action on the other screen:
 *   node pair-final.mjs stage1   -> types endpoint+code, captures the challenge fingerprint
 *   ... human approves in the hub's Devices UI ...
 *   node pair-final.mjs stage2   -> reads the connected state, scopes, and the share permission
 *
 * The code is passed in from scratch and never written to evidence.
 */
import { _electron as electron } from '@playwright/test';

// Machine paths come from the environment so no committed file hardcodes the owner's
// username (§5 forbids machine inventories in committed files).
const NP_SCRATCH = process.env.NP_SCRATCH;
const NP_CLONE  = process.env.NP_CLONE;
if (!NP_SCRATCH || !NP_CLONE) { console.error('set NP_SCRATCH and NP_CLONE (see the report)'); process.exit(2); }

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const EV = '.agents/evidence/final';
const SCRATCH = NP_SCRATCH;
const SANDBOX = 'C:\\np-final';
const stage = process.argv[2] ?? 'stage1';
mkdirSync(EV, { recursive: true });

const out = { stage, startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 460)); };

// The pairing code is read from scratch at run time; never echoed, never persisted to evidence.
const code = readFileSync(`${NP_SCRATCH}/final-pair-code.txt`, 'utf8').trim();

let app, win;
try {
  app = await electron.launch({
    args: ['.'],
    cwd: `${NP_CLONE}/windows-companion`,
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: SANDBOX, NODE_ENV: 'development' },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);
  log('launched', { title: await win.title() });

  if (stage === 'stage1') {
    // Remote tab, then the Hub connection pane.
    const remote = win.locator('text=Remote').first();
    if (await remote.count()) { await remote.click(); await win.waitForTimeout(1000); }
    const hubPane = win.locator('text=Hub connection').first();
    if (await hubPane.count()) { await hubPane.click(); await win.waitForTimeout(800); }
    await win.screenshot({ path: `${EV}/final-companion-hubpanel.png` });

    // What a first-time owner actually sees, verbatim.
    const before = await win.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200));
    const fields = await win.$$eval('input, button, [role="button"]', (els) =>
      els.map((e) => ({
        tag: e.tagName,
        label: e.getAttribute('aria-label') || e.labels?.[0]?.innerText || null,
        ph: e.getAttribute('placeholder'),
        value: e.value ?? null,
        hint: e.getAttribute('data-hint') || e.parentElement?.querySelector?.('.companion-hint')?.innerText?.slice(0, 90) || null,
        text: (e.textContent || '').trim().slice(0, 40),
        disabled: e.disabled === true,
        type: e.getAttribute('type'),
      }))
    );
    log('panel-before-typing', { body: before, fields });

    // Type what a person types: the address, then the code.
    // My first attempt used `input` .first() and matched the "Let paired devices stream from this
    // PC" CHECKBOX instead of the address field, failing with "Input of type checkbox cannot be
    // filled". Hub.tsx wraps both TextFields in `.companion-form`, so scope to that.
    const form = win.locator('.companion-form');
    const textInputs = form.locator('input:not([type="checkbox"])');
    const n = await textInputs.count();
    log('form-inputs', { count: n });
    await textInputs.nth(0).fill('http://127.0.0.1:4546');
    await textInputs.nth(1).fill(code);
    await win.waitForTimeout(400);
    const disabledBeforeClick = await win.locator('button').evaluateAll((b) => b.map((x) => ({ t: (x.textContent || '').trim().slice(0, 30), disabled: x.disabled })));
    log('typed', { disabledStates: disabledBeforeClick });

    // The connect button becomes enabled only when both fields are non-empty.
    const connect = form.locator('button').first();
    await connect.click();
    await win.waitForTimeout(5000);

    // The challenge: the fingerprint a person compares against the hub's screen.
    const challenge = await win.evaluate(() => {
      const fp = document.querySelector('.companion-fingerprint');
      const txt = document.body.innerText.replace(/\s+/g, ' ');
      const m = txt.match(/hub fingerprint\s*([0-9A-F-]{8,})/i);
      return {
        verificationFingerprint: fp ? fp.innerText.trim() : null,
        hubFingerprintFromText: m ? m[1] : null,
        waitingForApproval: /waiting for someone at the hub to confirm/i.test(txt),
        body: txt.slice(0, 700),
      };
    });
    log('challenge', challenge);
    await win.screenshot({ path: `${EV}/final-companion-challenge.png` });
  } else {
    // Human has approved in the hub's Devices UI. Read what the companion now believes.
    await win.waitForTimeout(2000);
    const status = await win.evaluate(() => {
      const txt = document.body.innerText.replace(/\s+/g, ' ');
      const grab = (label) => {
        const m = txt.match(new RegExp(label + '\\s*([^]{2,120})', 'i'));
        return m ? m[1].trim() : null;
      };
      return {
        body: txt.slice(0, 1200),
        hub: grab('Hub'),
        status: grab('Status'),
        fingerprint: grab('Fingerprint'),
        may: grab('This computer may'),
        lastSync: grab('Last sync'),
        forgetVisible: /forget this hub/i.test(txt),
        shareCheckboxVisible: /let the hub see what music is on this computer/i.test(txt),
      };
    });
    log('connected-state', status);

    // The share permission must be OFF by default and must actually stick.
    const checkboxes = await win.$$eval('input[type="checkbox"]', (els) =>
      els.map((e) => ({ checked: e.checked, label: e.labels?.[0]?.innerText?.trim().slice(0, 80) || e.getAttribute('aria-label') }))
    );
    log('permissions', { checkboxes });
    await win.screenshot({ path: `${EV}/final-companion-connected.png` });
  }
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  // The code is stripped from anything persisted, as a belt-and-braces measure.
  const safe = JSON.stringify(out, null, 2).split(code).join('<PAIRING-CODE>');
  writeFileSync(`${EV}/final-pair-${stage}.json`, safe);
  console.log('WROTE', `${EV}/final-pair-${stage}.json`);
  if (app && stage === 'stage2') await app.close().catch(() => {});
  else if (app) console.log('APP LEFT OPEN (stage1) - close it before stage2');
}
