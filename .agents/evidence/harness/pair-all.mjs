#!/usr/bin/env node
/**
 * Pairs the companion with the hub in ONE browser session, because the hub's pending pairing
 * session belongs to the signed-in operator: minting a code in one browser and confirming it in
 * another signs in again and the session is gone. (That is the hub behaving correctly — a pairing
 * code is issued to the operator who asked for it.)
 *
 * §2.5 also asks whether sharing starts by itself, so nothing here ticks a sharing box: the
 * companion's state is read afterwards and reported as it is.
 *
 *   node .agents/evidence/harness/pair-all.mjs --hub http://127.0.0.1:4550
 */
import { _electron as electron, chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const HUB = arg('hub', 'http://127.0.0.1:4550');
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const secrets = JSON.parse(readFileSync(join(SCRATCH, 'hub-secrets.json'), 'utf8'));
const log = (m) => console.log(m);

/* ------------------------------------------------------------------ the hub, one session */
const browser = await chromium.launch({ headless: true });
const hub = await browser.newPage();
await hub.goto(HUB, { waitUntil: 'domcontentloaded' });
await hub.getByLabel('Password:').fill(secrets.password);
await hub.getByRole('button', { name: 'Sign In' }).click();
await hub.getByRole('tab', { name: 'Devices' }).click();
await hub.locator('#devKind').selectOption('companion');
await hub.waitForTimeout(300);

// What the companion is allowed to do: read this before ticking, and record the default.
const defaultTicked = [];
for (const s of await hub.locator('fieldset.scopes input[type=checkbox]').all()) {
  if (await s.isChecked()) {
    defaultTicked.push(await s.evaluate((el) => document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim().split('\n')[0]));
  }
}
log(`hub scopes ticked by default for a companion: ${JSON.stringify(defaultTicked)}`);

// §2.5's claim is about pairing with a hub THAT GRANTS LIBRARY SHARING, so the grant has to be
// given. `library:share` is deliberately NOT in the hub's DEFAULT_SCOPES
// (docker-container/src/web/views/Devices.tsx:20), so without this tick the companion correctly
// refuses to share and the claim reads as false. Tick it the way a person does, by its label.
if (process.argv.includes('--grant-share')) {
  const shareLabel = hub.locator('fieldset.scopes label.chk', { hasText: 'Share from the library' }).first();
  if (await shareLabel.count()) {
    await shareLabel.click();
    await hub.waitForTimeout(400);
    const nowChecked = await hub.getByLabel(/Share from the library/).isChecked();
    log(`ticked "Share from the library" (library:share) -> checked=${nowChecked}`);
  } else {
    log('FAIL no "Share from the library" checkbox on the Devices tab');
  }
}

await hub.getByRole('button', { name: 'Start Pairing…' }).click();
await hub.waitForFunction(
  () => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(document.querySelector('[aria-label="Pairing code"]')?.textContent?.trim() ?? ''),
  null,
  { timeout: 30_000 },
);
const code = (await hub.getByLabel('Pairing code').innerText()).trim();
log(`hub pairing code: ${code}`);
await hub.screenshot({ path: join(EVIDENCE, '32-hub-devices-pairing.png') });

/* ------------------------------------------------------------------ the companion claims it */
const root = join(CLONE, 'windows-companion', 'release', 'win-unpacked');
const app = await electron.launch({
  executablePath: join(root, 'Airwave Companion.exe'),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_DIR: SCRATCH,
    NP_DATA_DIR: join(SCRATCH, 'hub'),
    NP_HELPER_PORT: process.env.NP_HELPER_PORT ?? '17342',
  },
});
log(`COMPANION_PID=${app.process().pid}`);
const comp = await app.firstWindow();
await comp.waitForLoadState('domcontentloaded');
await comp.waitForTimeout(1500);
await comp.getByRole('tab', { name: 'Remote', exact: false }).first().click({ timeout: 30_000 });
await comp.waitForTimeout(2000);

// The "Hub connection" fieldset only renders while UNPAIRED. A credential from an earlier run is
// stored in the companion's profile, and re-pairing then never shows the address field — so when
// one exists, forget it first. That is also §2.5's own "a second hub refuses the old credential"
// step, done deliberately.
const alreadyPaired = await comp.evaluate(() => /Forget This Hub/.test(document.body.innerText ?? ''));
if (alreadyPaired) {
  console.log('a hub is already paired - forgetting it before re-pairing');
  await comp.getByRole('button', { name: 'Forget This Hub…' }).first().click();
  await comp.waitForTimeout(1200);
  const yes = comp.getByRole('button', { name: /^Forget/ }).last();
  if (await yes.count()) await yes.click();
  await comp.waitForTimeout(3000);
  console.log('forgot the previously paired hub');
}
await comp.getByLabel('Hub address').waitFor({ timeout: 45_000 });
await comp.getByLabel('Hub address').fill(HUB);
await comp.getByRole('textbox', { name: 'Pairing code' }).fill(code.replace(/-/g, ''));
await comp.getByRole('button', { name: 'Pair', exact: true }).click();

// The companion shows a fingerprint; the hub issues nothing until it is typed back.
await comp.waitForFunction(() => /[0-9A-F]{4}-[0-9A-F]{4}/i.test(document.body.innerText), null, { timeout: 60_000 });
const body = (await comp.locator('body').innerText()).replace(/\s+/g, ' ');
const fingerprint = (body.match(/\b([0-9A-F]{4}(?:-[0-9A-F]{4}){1,4})\b/i) ?? [])[1] ?? '';
log(`companion verification fingerprint: ${fingerprint || '(none)'}`);
await comp.screenshot({ path: join(EVIDENCE, '33-companion-pairing-fingerprint.png') });

if (fingerprint) {
  const field = hub.getByLabel('Verification code');
  await field.waitFor({ timeout: 20_000 });
  await field.fill(fingerprint);
  await hub.getByRole('button', { name: 'Confirm', exact: true }).click();
  log('hub: fingerprint confirmed');
}
await hub.waitForTimeout(7000);
await hub.screenshot({ path: join(EVIDENCE, '34-hub-devices-after-pairing.png') });
log(`hub Devices: ${(await hub.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 700)}`);

/* --------------------------------------- is sharing on by itself? nothing was ticked in the companion */
await comp.waitForTimeout(10_000);
const sharing = await comp.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('input[type=checkbox]')) {
    const lab = el.closest('label') ?? document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    out.push({
      label: (lab?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
      checked: el.checked,
      disabled: el.disabled,
    });
  }
  return out;
});
log(`companion checkboxes after pairing (nothing ticked by this script):`);
for (const s of sharing) log(`  [${s.checked ? 'x' : ' '}] ${s.label}${s.disabled ? ' (disabled)' : ''}`);
const hubText = (await comp.locator('body').innerText()).replace(/\s+/g, ' ');
log(`companion status: ${hubText.slice(0, 900)}`);
await comp.screenshot({ path: join(EVIDENCE, '35-companion-after-pairing.png') });

await app.close();
await browser.close();