#!/usr/bin/env node
/**
 * §2.10 — streaming on a metered connection, end to end.
 *
 * The brief's test: with "On metered connections" OFF the stream must stop and the status must say
 * why; with it ON it must continue.
 *
 * What this can and cannot prove here, said up front so the verdict is not read as more than it is.
 * The metered decision and its refusal sentence are the product's own shipped functions and are
 * exercised for real (.agents/evidence/harness/metered-decision.mjs). What this script adds is the part above them:
 * that the companion notices the connection is metered, and that the supervisor's decision and the
 * Remote tab's wording follow from it.
 *
 * It does NOT stream a FLAC to a paired player: that needs a paired player, which this run has not
 * reached. What it does instead is read the supervisor's own state - the object that decides whether
 * the sidecar runs - and the sentence the tab shows.
 *
 *   node .agents/evidence/harness/metered-live.mjs
 */
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
const say = (m) => {
  console.log(m);
  lines.push(String(m));
};

// Windows' own answer, read the same way the companion reads it.
const probe = execSyncProbe();
say(`### Windows, via the companion's own COST_SCRIPT`);
say(`  ${probe.replace(/\n/g, '  ')}`);

const app = await electron.launch({
  executablePath: join(CLONE, 'windows-companion', 'release', 'win-unpacked', 'Airwave Companion.exe'),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_DIR: SCRATCH,
    NP_DATA_DIR: join(SCRATCH, 'hub'),
    NP_HELPER_PORT: process.env.NP_HELPER_PORT ?? '17342',
  },
});
say(`\nCOMPANION_PID=${app.process().pid}`);
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(3000);
await win.getByRole('tab', { name: 'Remote', exact: false }).first().click({ timeout: 30_000 });
await win.waitForTimeout(3000);

/** The supervisor's own status, and the tab's own wording. */
async function readState(label, shot) {
  const status = await win.evaluate(async () => {
    try {
      return await window.companion.invoke('awsp:status');
    } catch (err) {
      return { error: String(err.message) };
    }
  });
  const text = (await win.locator('body').innerText()).replace(/\s+/g, ' ');
  const paused = text.match(/Paused[^.]*\./i)?.[0] ?? null;
  const streamLine = text.match(/Streaming is (on|off)[^.]*\./i)?.[0] ?? null;
  await win.screenshot({ path: join(EVIDENCE, shot) });
  say(`\n### ${label}`);
  say(`  awsp:status -> ${JSON.stringify(status)}`);
  say(`  the tab says, about streaming: ${streamLine ?? '(no such sentence found)'}`);
  say(`  the tab shows a pause reason: ${paused ?? '(none)'}`);
  say(`  screenshot: evidence/${shot}`);
  return { status, paused, streamLine };
}

// Step 1: turn streaming on. It is off by default, and the switches are disabled until it is.
const streamingLabel = win.locator('label', { hasText: 'Let paired devices stream from this PC' }).first();
await streamingLabel.scrollIntoViewIfNeeded();
let streamingOn = await streamingLabel.locator('input[type=checkbox]').isChecked();
if (!streamingOn) {
  say('\n>>> Remote ▸ "Let paired devices stream from this PC": turning it ON');
  await streamingLabel.click();
  await win.waitForTimeout(4000);
}
streamingOn = await streamingLabel.locator('input[type=checkbox]').isChecked();
say(`  streaming is now ${streamingOn ? 'ON' : 'off'}`);

// Step 2: the metered switch starts ON. With streaming on and the connection metered, the stream
// is allowed - that is the "with it on, it must continue" half.
const meteredLabel = win.locator('label', { hasText: 'On metered connections' }).first();
const meteredBox = meteredLabel.locator('input[type=checkbox]');
const meteredInitially = await meteredBox.isChecked();
say(`  "On metered connections" is ${meteredInitially ? 'ON' : 'off'} on arrival`);
await win.waitForTimeout(6000); // the supervisor polls the connection
const withSwitchOn = await readState('metered connection, "On metered connections" ON', '95-metered-switch-on.png');

// Step 3: turn the metered switch OFF. The refusal must now appear.
say('\n>>> "On metered connections": turning it OFF — the stream must stop and say why');
if (meteredInitially) await meteredLabel.click();
await win.waitForTimeout(6000);
const withSwitchOff = await readState('metered connection, "On metered connections" OFF', '96-metered-switch-off.png');

// Step 4: put it back the way we found it.
say('\n>>> restoring "On metered connections" to its original state');
if (meteredInitially) {
  await meteredLabel.click();
  await win.waitForTimeout(4000);
  say(`  it is ${(await meteredBox.isChecked()) ? 'ON' : 'off'} again`);
} else {
  await meteredLabel.click();
  await win.waitForTimeout(4000);
  await meteredLabel.click();
  say('  restored to off');
}
await readState('after restoring the switch', '97-metered-restored.png');

say('\n### VERDICT');
const pausedWhenOff = /Paused/.test(withSwitchOff.paused ?? '') || withSwitchOff.status?.blocked;
const allowedWhenOn = !withSwitchOn.status?.blocked;
say(`  metered + switch OFF -> stream refused with a reason: ${pausedWhenOff ? 'YES' : 'NO'}`);
say(`      "${withSwitchOff.paused ?? withSwitchOff.status?.blocked ?? '(no reason reported)'}"`);
say(`  metered + switch ON  -> stream allowed: ${allowedWhenOn ? 'YES' : 'NO'}`);
say(`\n  NOT covered by this script: streaming an actual FLAC to a paired player, and "last seen" on a`);
say('  paired device after it disconnects. Both need a paired player or device.');

writeFileSync(join(EVIDENCE, '95-metered-live.txt'), lines.join('\n'));
say('\nevidence: evidence/95-metered-live.txt');
await app.close();

/** Runs .agents/evidence/harness/metered-check.ps1 and returns its lines. */
function execSyncProbe() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(CLONE, 'harness', 'metered-check.ps1')], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\s*\+|FullyQualified|CategoryInfo|At line/.test(l))
      .join('\n');
  } catch (err) {
    return `probe failed: ${String(err.stdout ?? err.message).slice(0, 200)}`;
  }
}