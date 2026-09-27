/**
 * Did removing the application menu break copy/paste?
 *
 * This is the one regression risk of `Menu.setApplicationMenu(null)`. The Edit menu carries the
 * `copy`/`cut`/`paste`/`selectAll` ROLES; removing the menu removes the roles with it. On Windows
 * Chromium handles those accelerators inside an input itself, so the expectation is that they keep
 * working — but "expected" is not evidence, and the companion's whole pairing flow asks a person to
 * copy a verification code off one screen and type it into another.
 *
 * So this drives the INSTALLED app, types into a real text field, sends the real Ctrl+C, and reads
 * the clipboard back out of the main process. If the menu roles had been load-bearing, the
 * clipboard would come back empty or stale.
 *
 * Read-only apart from the clipboard and the typed text, which is a temporary localhost URL.
 *
 * Run: node .agents/evidence/verify-installed-clipboard.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INSTALLED = join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Now Playing Companion', 'Now Playing Companion.exe');
const EV = 'C:/Users/jalon/AudioWave2.0/.agents/evidence/05-installer';
mkdirSync(EV, { recursive: true });

const SENTINEL = 'http://127.0.0.1:4546';
const report = { installedExe: INSTALLED, checks: [], errors: [] };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const app = await electron.launch({ executablePath: INSTALLED, args: [], timeout: 120_000 });
try {
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  // Prove there is no application menu in this same process, so a clipboard failure could only be
  // about the roles, not about the app being some other build.
  const menu = await app.evaluate(({ Menu }) => ({ isNull: Menu.getApplicationMenu() === null }));
  check('no application menu in this process (the condition under test)', menu.isNull, JSON.stringify(menu));

  // The app opens on the Library tab, which has no text input at all. The pairing fields live under
  // Remote > Hub connection, so navigate the way a person would before looking for a field.
  const beforeTabs = await win.locator('[role="tab"]').allTextContents();
  report.tabsSeen = beforeTabs;
  console.log('tabs:', JSON.stringify(beforeTabs));
  await win.getByRole('tab', { name: 'Remote', exact: true }).click();
  await win.waitForTimeout(750);

  // Find a text field a person could plausibly type into. Settings/Connections carries the hub
  // address; any editable input exercises the same accelerator path.
  const fields = await win.evaluate(() =>
    [...document.querySelectorAll('input[type=text], input:not([type]), input[type=url], input[type=password]')]
      .filter((i) => !i.disabled && !i.readOnly)
      .map((i) => ({ id: i.id || null, placeholder: i.placeholder || null, type: i.type || null, label: i.getAttribute('aria-label') || null })),
  );
  report.textFields = fields;
  console.log('editable text fields after navigating to Remote:', JSON.stringify(fields));
  check('the app has at least one editable text field to test', fields.length > 0, `${fields.length} found`);

  if (fields.length > 0) {
    // Address the fields by their runtime ids via an attribute selector — no CSS.escape (a browser
    // global) and no literal id (they are generated). Deliberately text inputs only: a bare
    // `input` also matches the Aqua checkbox's 1 px, opacity-0 input, which sits behind a drawn
    // label that intercepts the click.
    const inputFor = (i) => win.locator(`input[id="${i.id}"]`);
    const first = inputFor(fields[0]);
    await first.click();
    await win.keyboard.press('Control+A');
    await win.keyboard.type(SENTINEL);
    await win.keyboard.press('Control+A');
    await win.keyboard.press('Control+C');

    // Read the clipboard from the MAIN process — the real Windows clipboard, not a page shim.
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    report.clipboard = clip;
    check('Ctrl+A then Ctrl+C copies the focused field (Edit-menu roles not needed)',
      clip === SENTINEL, `clipboard=${JSON.stringify(clip)}`);

    // And paste, into a second field if there is one.
    if (fields.length > 1) {
      const second = inputFor(fields[1]);
      await second.click();
      await win.keyboard.press('Control+A');
      await win.keyboard.press('Control+V');
      const pasted = await second.inputValue();
      check('Ctrl+V pastes from the clipboard', pasted === SENTINEL, `field=${JSON.stringify(pasted)}`);
    } else {
      report.note = 'only one editable field, so paste was not exercised separately';
    }
  }

  writeFileSync(join(EV, 'installed-clipboard-check.json'), JSON.stringify(report, null, 2));
  console.log(`\nWROTE ${join(EV, 'installed-clipboard-check.json')}`);
  process.exitCode = report.checks.every((c) => c.pass) ? 0 : 1;
} catch (err) {
  report.errors.push(String(err?.stack ?? err));
  console.error('FATAL ' + report.errors[0]);
  writeFileSync(join(EV, 'installed-clipboard-check.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}
