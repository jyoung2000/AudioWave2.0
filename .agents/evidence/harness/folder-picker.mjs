#!/usr/bin/env node
/**
 * §2.5's native folder picker, driven end to end with no person involved.
 *
 * Two halves that have to happen in the same process, because the dialog only exists while the app
 * is up:
 *   1. a TRUSTED Playwright click on "Add Folder…", which makes Electron call
 *      dialog.showOpenDialog(mainWindow, ...) — that blocks the main thread, so a synthetic
 *      element.click() from page.evaluate does not even open it;
 *   2. UI Automation against the dialog, from a child process.
 *
 * The dialog is an OWNED window: it is a descendant of the companion's top-level window, not a
 * sibling under the desktop root. Searching only root children reports "no window titled ..." while
 * the dialog is plainly on screen, which is what an earlier version of uia-folder-picker.ps1 did.
 *
 *   node .agents/evidence/harness/folder-picker.mjs
 */
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const MUSIC = join(SCRATCH, 'music');
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const UIA = join(CLONE, 'harness', 'uia-folder-picker.ps1');
// The titles and the button label come from the companion's own source
// (windows-companion/src/main/index.ts:556-557), not from guesswork.
const DIALOG = 'Choose a music folder';
const CONFIRM = 'Add folder';

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
const pid = app.process().pid;
say(`COMPANION_PID=${pid}`);

const readFolders = () =>
  app.firstWindow().then(async (w) => {
    try {
      return await w.evaluate(async () => await window.companion.invoke('library:folders'));
    } catch (err) {
      return { error: String(err.message) };
    }
  });

const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);
say(`folders before: ${JSON.stringify(await readFolders())}`);

const addFolder = win.locator('button').filter({ hasText: /^Add Folder/ }).first();
await addFolder.scrollIntoViewIfNeeded();
await addFolder.click({ noWaitAfter: true }); // trusted click; the main thread blocks from here
say(`clicked "Add Folder…" (trusted) - waiting for "${DIALOG}"`);

await new Promise((r) => setTimeout(r, 10_000)); // let the shell dialog build its window

let uia;
try {
  uia = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', UIA, '-ProcessId_', String(pid),
     '-DialogTitle', DIALOG, '-FolderPath', MUSIC, '-ConfirmButton', CONFIRM, '-TimeoutSeconds', '40',
     '-ExpectedProcessName', 'Airwave Companion'],
    { encoding: 'utf8', timeout: 120_000 },
  );
  say(uia.trim());
} catch (err) {
  say(`UI Automation did not complete. Its own output:\n${String(err.stdout ?? '').trim() || err.message}`);
  // Say what WAS on screen, so "not found" is a fact about the machine and not a guess.
  try {
    const seen = execFileSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
       "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes;" +
       "$r=[System.Windows.Automation.AutomationElement]::RootElement;" +
       "$c=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'#32770');" +
       "$r.FindAll([System.Windows.Automation.TreeScope]::Descendants,$c) | ForEach-Object { 'DIALOG pid=' + $_.Current.ProcessId + ' name=' + $_.Current.Name }"],
      { encoding: 'utf8', timeout: 60_000 },
    );
    say(`\nwhat was actually on screen:\n${seen.trim() || '  (no #32770 shell dialog anywhere on the desktop)'}`);
  } catch {}
  say(`\nFALLBACK NEEDED: a person must click Add Folder, choose ${MUSIC}, and press "${CONFIRM}".`);
  writeFileSync(join(EVIDENCE, '90-folder-picker.txt'), lines.join('\n'));
  await app.close().catch(() => {});
  process.exit(4);
}

await win.waitForTimeout(6000);
const after = await readFolders();
say(`\nfolders after: ${JSON.stringify(after)}`);

// The scan that follows is §2.5's "the hub follows the folder", and it needs no person.
await win.waitForTimeout(15000);
const tracks = await win.evaluate(async () => {
  try {
    return await window.companion.invoke('library:tracks', { limit: 50, offset: 0 });
  } catch (err) {
    return { error: String(err.message) };
  }
});
const total = tracks?.total ?? 0;
say(`\nlibrary after the scan: total=${total}`);
if (Array.isArray(tracks?.items)) {
  for (const t of tracks.items.slice(0, 12)) {
    const rec = t.record ?? t;
    say(`  ${(rec.track?.title ?? rec.title ?? '?').slice(0, 44).padEnd(44)} tempo=${rec.bpm ?? rec.tempoBpm ?? '—'}`);
  }
}
await win.screenshot({ path: join(EVIDENCE, '90-folder-picker.png') });
say('screenshot: evidence/90-folder-picker.png');
writeFileSync(join(EVIDENCE, '90-folder-picker.txt'), lines.join('\n'));
say('\nevidence: evidence/90-folder-picker.txt');
await app.close();
process.exit(total > 0 ? 0 : 5);
