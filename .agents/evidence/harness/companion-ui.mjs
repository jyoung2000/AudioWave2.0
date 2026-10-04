#!/usr/bin/env node
/**
 * Drives the PACKAGED Airwave Companion through Playwright's Electron support.
 *
 * Packaged, not `electron .`: §2.4's claim is about the shipped build, and the sandbox variables
 * (PORTABLE_EXECUTABLE_DIR / NP_DATA_DIR / a PATH without FFmpeg) must apply to it exactly as a
 * person's launch would.
 *
 *   node .agents/evidence/harness/companion-ui.mjs setup-state                 -> tool/downloader status as JSON
 *   node .agents/evidence/harness/companion-ui.mjs shot <name> [tab]           -> screenshot into $NP_SCRATCH/evidence
 *   node .agents/evidence/harness/companion-ui.mjs dump                        -> every control's accessible name
 *   node .agents/evidence/harness/companion-ui.mjs click <accessibleName>
 *   node .agents/evidence/harness/companion-ui.mjs eval <js expression>        -> evaluated in the renderer
 *
 * The PID Playwright launches is printed as COMPANION_PID so the caller records exactly that.
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
if (!SCRATCH || !CLONE) {
  console.error('NP_SCRATCH and NP_CLONE must be set');
  process.exit(2);
}
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });

const argv = process.argv.slice(2);
// Flags consumed by this script, not by the command it runs.
const FLAGS = new Set(['--no-ffmpeg']);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'dump';
const cmdArgs = argv.filter((a) => !FLAGS.has(a) && a !== cmd);

const winDir = join(CLONE, 'windows-companion');
const root = ['release/win-unpacked', 'dist/win-unpacked', 'out/win-unpacked']
  .map((d) => join(winDir, d))
  .find((d) => existsSync(join(d, 'Airwave Companion.exe')));
if (!root) {
  console.error('No packaged companion. Run `pnpm build:windows` first.');
  process.exit(3);
}
const exe = join(root, 'Airwave Companion.exe');

/** §2.4 needs FFmpeg to be absent from PATH; nothing is uninstalled or moved. */
function stripFfmpeg(pathValue) {
  const removed = [];
  const kept = pathValue
    .split(';')
    .filter(Boolean)
    .filter((dir) => {
      if (existsSync(join(dir, 'ffmpeg.exe'))) {
        removed.push(dir);
        return false;
      }
      return true;
    });
  return { path: kept.join(';'), removed };
}

const env = { ...process.env };
env.PORTABLE_EXECUTABLE_DIR = SCRATCH;
env.NP_DATA_DIR = join(SCRATCH, 'hub');
env.NP_HELPER_PORT = process.env.NP_HELPER_PORT ?? '17342';
if (process.argv.includes('--no-ffmpeg')) {
  const { path, removed } = stripFfmpeg(env.PATH ?? '');
  env.PATH = path;
  console.error(`ffmpeg removed from PATH: ${removed.join(', ') || '(none found)'}`);
}
if (process.env.NP_EXTRA_PATH_PREFIX) env.PATH = `${process.env.NP_EXTRA_PATH_PREFIX};${env.PATH}`;

const app = await electron.launch({ executablePath: exe, env, args: process.env.NP_COMPANION_ARGS ? process.env.NP_COMPANION_ARGS.split(' ') : [] });
console.log(`COMPANION_PID=${app.process().pid}`);
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
// The renderer sets NP_READY when the window's own data has loaded; wait for it like a person
// waiting for the app to be usable.
await win.waitForFunction(() => window.NP_READY !== undefined, null, { timeout: 60_000 }).catch(() => {});
console.log(`title=${await win.title()} url=${win.url()}`);

async function dumpControls() {
  // Everything a person can reach: buttons, links, tabs, checkboxes, textboxes, radios, headings,
  // with their state, so the report quotes the real names rather than guesses.
  return win.evaluate(() => {
    const sel = 'button,a[href],[role],input,select,summary,h1,h2,h3,label,[id]';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const name =
        el.getAttribute('aria-label') ||
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) ||
        el.textContent?.trim().slice(0, 80) ||
        el.value ||
        '';
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        id: el.id || '',
        name: name.replace(/\s+/g, ' ').trim().slice(0, 100),
        checked: 'checked' in el ? el.checked : undefined,
        value: 'value' in el ? String(el.value).slice(0, 60) : undefined,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });
    }
    return out;
  });
}

try {
  switch (cmd) {
    case 'dump': {
          const which = cmdArgs[0];
          if (which) {
            // Reveal one section first, so its controls are in the dump rather than hidden behind a tab.
            await win.getByRole('tab', { name: which, exact: false }).first().click({ timeout: 15_000 });
            await win.waitForTimeout(900);
          }
          const controls = await dumpControls();
          const file = join(EVIDENCE, `companion-controls-${which ?? 'all'}-${Date.now()}.json`);
          writeFileSync(file, JSON.stringify(controls, null, 2));
          console.log(`controls written to ${file}`);
          for (const c of controls) {
            console.log(`${c.tag}${c.role ? '[' + c.role + ']' : ''} id=${c.id} checked=${c.checked ?? ''} :: ${c.name} | ${c.text}`);
          }
          break;
        }
    case 'shot': {
      const name = cmdArgs[0] ?? 'companion';
      const tab = cmdArgs[1];
      if (tab) {
        await win.getByRole('tab', { name: tab, exact: false }).click().catch(async () => {
          await win.getByText(tab, { exact: false }).first().click();
        });
        await win.waitForTimeout(900);
      }
      const file = join(EVIDENCE, `${name}.png`);
      await win.screenshot({ path: file });
      console.log(`saved ${file}`);
      break;
    }
    case 'click': {
      const name = cmdArgs[0];
      if (!name) throw new Error('click needs an accessible name');
      await win.getByRole('button', { name }).first().click({ timeout: 15_000 });
      await win.waitForTimeout(700);
      console.log(`clicked ${name}`);
      break;
    }
    case 'eval': {
      const expr = cmdArgs.join(' ');
      const result = await win.evaluate((src) => {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${src})`)();
      }, expr);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'setup-state': {
      // Whatever the renderer holds about the downloaders/tools, read straight off its own store
      // rather than inferred from pixels.
      const state = await win.evaluate(() => {
        const w = window;
        const out = {};
        for (const k of Object.keys(w)) {
          if (/state|store|settings|tools|download/i.test(k)) {
            try {
              const v = w[k];
              if (v && typeof v === 'object') out[k] = JSON.parse(JSON.stringify(v));
            } catch {}
          }
        }
        return out;
      });
      console.log(JSON.stringify(state, null, 2).slice(0, 20000));
      break;
    }
    default:
      console.error(`unknown command ${cmd}`);
      process.exitCode = 2;
  }
} finally {
  await app.close().catch(() => {});
}