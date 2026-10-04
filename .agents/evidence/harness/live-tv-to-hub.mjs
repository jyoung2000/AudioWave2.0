#!/usr/bin/env node
/**
 * §2.5's Live TV chain, end to end:
 *
 *   companion Live TV tab  ->  hub (PUT /api/v1/live-tv)  ->  withdrawn again on DELETE
 *
 * The publish is `pushLiveTv()` in windows-companion/src/main/hub.ts, debounced 3s, and
 * `hub:share-library` (index.ts:610) schedules an immediate push when sharing is toggled — which is
 * what makes the DELETE land.
 *
 * The hub's DATA is read from its own API, not from the Music tab: the group title "Live TV from the
 * companion" is static explanatory copy shown whether or not there is anything behind it, so reading
 * the page for that string proves nothing. (Getting that wrong was the first version of this script.)
 *
 *   node .agents/evidence/harness/live-tv-to-hub.mjs --hub http://127.0.0.1:4550
 */
import { _electron as electron, chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const lines = [];
const say = (m) => {
  console.log(m);
  lines.push(String(m));
};

const app = await electron.launch({
  executablePath: join(CLONE, 'windows-companion', 'release', 'win-unpacked', 'Airwave Companion.exe'),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_DIR: SCRATCH,
    NP_DATA_DIR: join(SCRATCH, 'hub'),
    NP_HELPER_PORT: process.env.NP_HELPER_PORT ?? '17342',
  },
});
say(`COMPANION_PID=${app.process().pid}`);
const comp = await app.firstWindow();
await comp.waitForLoadState('domcontentloaded');
await comp.waitForTimeout(2000);
await comp.getByRole('tab', { name: 'Remote', exact: false }).first().click({ timeout: 30_000 });
await comp.waitForTimeout(2500);

/** The hub's own Live TV data, over its API, as the signed-in admin. */
async function hubLiveTv(label, shot) {
  const browser = await chromium.launch({ headless: true });
  const hub = await (await browser.newContext()).newPage();
  await hub.goto(HUB, { waitUntil: 'domcontentloaded' });
  await hub.getByLabel('Password:').fill(secrets.password);
  await hub.getByRole('button', { name: 'Sign In' }).click();
  await hub.waitForTimeout(1200);
  const data = await hub.evaluate(async () => {
    const r = await fetch('/api/v1/live-tv', { credentials: 'include' });
    return { status: r.status, body: await r.json() };
  });
  await hub.getByRole('tab', { name: 'Music' }).click();
  await hub.waitForTimeout(2000);
  const rows = await hub.locator('ul[aria-label="Live TV from the companion"] li, ul[aria-label="Live TV from the companion"] tr').count();
  await hub.screenshot({ path: join(EVIDENCE, shot) });
  await browser.close();
  say(`\n### ${label}`);
  say(`  GET /api/v1/live-tv -> ${data.status}`);
  say(`  channels=${data.body?.channels?.length ?? '?'}  guide=${data.body?.guide?.length ?? '?'}  updatedAt=${data.body?.updatedAt ?? 'null'}  sourceDevice=${data.body?.sourceDevice ?? 'null'}`);
  say(`  rows rendered under "Live TV from the companion" on the Music tab: ${rows}`);
  say(`  screenshot: evidence/${shot}`);
  return { ...data.body, rows };
}

const sharing0 = await comp.evaluate(async () => {
  try {
    return await window.companion.invoke('hub:sharing');
  } catch (err) {
    return { error: String(err.message) };
  }
});
say(`companion hub:sharing on arrival -> ${JSON.stringify(sharing0)}`);

const shareLabel = comp.locator('label', { hasText: 'Let the hub see what music is on this PC' }).first();
await shareLabel.scrollIntoViewIfNeeded();
let checked = await shareLabel.locator('input[type=checkbox]').isChecked();
if (!checked) {
  say('turning sharing ON');
  await shareLabel.click();
}
say('sharing is on; waiting for the debounced push to land');
await new Promise((r) => setTimeout(r, 25_000));
const on = await hubLiveTv('sharing ON', '36-hub-livetv-from-companion.png');
await comp.screenshot({ path: join(EVIDENCE, '39-companion-sharing-on.png') });

say('\n>>> turning sharing OFF');
checked = await shareLabel.locator('input[type=checkbox]').isChecked();
if (checked) await shareLabel.click();
await new Promise((r) => setTimeout(r, 25_000));
const stillOn = await shareLabel.locator('input[type=checkbox]').isChecked();
say(`  sharing is now ${stillOn ? 'ON' : 'off'}`);
await comp.screenshot({ path: join(EVIDENCE, '38-companion-sharing-off.png') });
const off = await hubLiveTv('sharing OFF', '37-hub-livetv-withdrawn.png');

say('\n### VERDICT');
const got = (on.channels?.length ?? 0) > 0;
const withdrew = (off.channels?.length ?? 0) === 0;
say(`  the companion's Live TV reached the hub while sharing was on: ${got ? 'YES' : 'NO'} (${on.channels?.length ?? 0} channels, ${on.guide?.length ?? 0} guide entries)`);
say(`  turning sharing off withdrew the hub's copy: ${withdrew ? 'YES' : 'NO'} (${off.channels?.length ?? 0} channels left)`);

writeFileSync(join(EVIDENCE, '36-live-tv-to-hub.txt'), lines.join('\n'));
say('\nevidence: evidence/36-live-tv-to-hub.txt');
await app.close();
process.exit(got && withdrew ? 0 : 5);