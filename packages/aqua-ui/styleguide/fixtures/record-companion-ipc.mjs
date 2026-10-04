/**
 * Records what a real companion answers on the channels its window reads, for the style guide's
 * companion specimens (`companion-ipc.json`, served to the real views by `fake-companion-bridge.ts`).
 *
 * It starts a packaged companion (`NP_COMPANION_EXE`, default the repository's own
 * `windows-companion/release/win-unpacked`) sandboxed with `PORTABLE_EXECUTABLE_DIR` in a scratch
 * folder, so the person's own companion data is never read or written, attaches over CDP, sets the
 * backup schedule the way a person would, makes one backup, asks every channel the Settings tab
 * reads, and stops the app by its PID. The scratch folder is written as the installed data folder
 * (`C:\Users\you\AppData\Roaming\now-playing-companion`), so no machine path reaches the repository.
 *
 *   NP_COMPANION_EXE=".../Airwave Companion.exe" node packages/aqua-ui/styleguide/fixtures/record-companion-ipc.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(join(repo, 'package.json'));
const { chromium } = require('@playwright/test');
const OUT = fileURLToPath(new URL('./companion-ipc.json', import.meta.url));
const EXE = process.env.NP_COMPANION_EXE ?? join(repo, 'windows-companion', 'release', 'win-unpacked', 'Airwave Companion.exe');
const CDP_PORT = Number(process.env.NP_RECORD_CDP_PORT ?? 9335);
const INSTALLED = 'C:\\Users\\you\\AppData\\Roaming\\now-playing-companion';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The channels the Settings tab and the window around it read, with the request each sends. */
const CHANNELS = [
  'app:info',
  'app:storage',
  'app:preferences:get',
  'app:update-status',
  'helper:status',
  'backup:settings:get',
  'backup:estimate',
  'backup:list',
  'backup:algorithms',
  'awsp:status',
  'hub:status',
  'library:folders',
  'tv:links',
  'transfers:list',
];

const sandbox = mkdtempSync(join(tmpdir(), 'np-comp-guide-'));
const app = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], { env: { ...process.env, PORTABLE_EXECUTABLE_DIR: sandbox }, stdio: 'ignore' });
console.info(`companion pid ${app.pid}`);
try {
  let browser;
  for (let i = 0; i < 80 && !browser; i += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      await sleep(250);
    }
  }
  if (!browser) throw new Error('the companion did not open its debugging port');
  await sleep(3000);
  const page = browser.contexts()[0].pages()[0];
  const invoke = (channel, request) => page.evaluate(([c, r]) => window.companion.invoke(c, r), [channel, request ?? null]);
  // The folder itself is chosen in a dialog (backup:pick-dir), which a recording cannot answer, so the
  // specimen shows a companion whose backups have a schedule but no folder yet.
  await invoke('backup:settings:set', { schedule: 'weekly', keep: 5 }).catch((error) => console.info('backup settings', String(error).slice(0, 160)));
  await sleep(2500);
  const answers = {};
  for (const channel of CHANNELS) {
    try {
      answers[channel] = await invoke(channel);
    } catch (error) {
      console.info(`skipped ${channel}: ${String(error).slice(0, 160)}`);
    }
  }
  await browser.close();

  let text = JSON.stringify({ recordedAt: new Date().toISOString(), channels: answers }, null, 2);
  // Every spelling of the scratch folder (and anything under it) becomes the installed data folder.
  const data = join(sandbox, 'NowPlayingCompanion-data');
  for (const [path, shown] of [
    [data, INSTALLED],
    [sandbox, INSTALLED],
  ]) {
    text = text.split(JSON.stringify(path).slice(1, -1)).join(JSON.stringify(shown).slice(1, -1));
    text = text.split(path.replace(/\\/g, '/')).join(shown.replace(/\\/g, '/'));
  }
  const user = process.env.USERNAME;
  if (user) text = text.split(`\\\\Users\\\\${user}\\\\`).join('\\\\Users\\\\you\\\\').split(`/Users/${user}/`).join('/Users/you/');
  if (/np-comp-guide-|AppData\\\\Local\\\\Temp/.test(text) || (user && text.includes(user))) throw new Error('a machine path survived sanitising');
  writeFileSync(OUT, `${text}\n`);
  console.info(`wrote ${Object.keys(answers).length} answers to ${OUT}`);
} finally {
  try {
    process.kill(app.pid);
  } catch {
    // already gone
  }
  console.info(`stopped ${app.pid}`);
}
