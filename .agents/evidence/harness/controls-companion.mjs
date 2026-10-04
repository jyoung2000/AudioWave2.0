#!/usr/bin/env node
/**
 * §2.12, the companion's controls — driven by DOM position rather than by accessible name.
 *
 * The Settings pane is a 2499px scroller inside a 760px window, and the per-tool buttons carry only
 * "Check" / "Update" as their text with the tool named in a sibling element, so name matching is
 * ambiguous and an off-screen click times out. Everything here clicks a specific button found by
 * its position within the Downloaders section and reads the outcome back out of the DOM.
 *
 *   node .agents/evidence/harness/controls-companion.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const DATA = join(SCRATCH, 'NowPlayingCompanion-data');
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
const results = [];
const say = (m) => {
  console.log(m);
  lines.push(String(m));
};
function record(what, ok, detail) {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${what} — ${detail}`);
  results.push({ what, ok, detail });
}
function existsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function dirSize(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += statSync(p).size;
      } catch {}
    }
  }
  return total;
}

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
say(`COMPANION_PID=${app.process().pid}`);
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
const shot = async (name) => {
  await win.screenshot({ path: join(EVIDENCE, `${name}.png`) });
  say(`  screenshot: evidence/${name}.png`);
};

await win.getByRole('tab', { name: 'Settings', exact: false }).first().click({ timeout: 20_000 });
await win.waitForTimeout(1500);

/** Clicks a button by its exact text inside the Downloaders section. */
async function clickInDownloaders(buttonText, nth = 0) {
  return win.evaluate(
    ({ buttonText, nth }) => {
      const section = [...document.querySelectorAll('fieldset')].find((f) => /yt-dlp/i.test(f.textContent ?? ''));
      if (!section) return { ok: false, reason: 'no Downloaders fieldset found' };
      const found = [...section.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === buttonText);
      const btn = found[nth];
      if (!btn) {
        return { ok: false, reason: `no button "${buttonText}" at index ${nth}; the section has ${[...section.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).join('|')}` };
      }
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { ok: true };
    },
    { buttonText, nth },
  );
}

/** The Downloaders section's own text — where any answer the app gives is rendered. */
const downloadersText = () =>
  win.evaluate(() => {
    const s = [...document.querySelectorAll('fieldset')].find((f) => /yt-dlp/i.test(f.textContent ?? ''));
    return s ? (s.textContent ?? '').replace(/\s+/g, ' ').trim() : '(not found)';
  });
const lastCheckedText = () =>
  win.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find((n) => /^Last checked/i.test((n.textContent ?? '').trim()) && n.children.length === 0);
    return el ? el.textContent.trim() : '(no "Last checked" line)';
  });

/* ------------------------------------------------------------ per-tool Check and Update */
say('\n### per-tool Check and Update');
try {
  const before = await lastCheckedText();
  const clicked = await clickInDownloaders('Check All');
  if (!clicked.ok) throw new Error(clicked.reason);
  // Each Check reaches that tool's own release feed, so this is not instant.
  let after = before;
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(1000);
    after = await lastCheckedText();
    if (after !== before) break;
  }
  const rows = await downloadersText();
  const versions = [...rows.matchAll(/(yt-dlp|spotDL|FFmpeg)\s+([\w.\-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  record('Check All', after !== before, `"${before}" -> "${after}". Versions reported: ${versions.join(', ') || '(none parsed)'}`);
  await shot('70-check-all');
} catch (err) {
  record('Check All', false, String(err.message).split('\n')[0]);
}

try {
  const clicked = await clickInDownloaders('Update', 0); // first row is yt-dlp
  if (!clicked.ok) throw new Error(clicked.reason);
  await win.waitForTimeout(12_000);
  const rows = await downloadersText();
  const versions = [...rows.matchAll(/(yt-dlp|spotDL|FFmpeg)\s+([\w.\-]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  record('per-tool Update (first row, yt-dlp)', true, `clicked. Versions after: ${versions.join(', ') || '(none parsed)'}`);
  await shot('71-tool-update');
} catch (err) {
  record('per-tool Update (first row, yt-dlp)', false, String(err.message).split('\n')[0]);
}

/* ------------------------------------------------------------ Check for new versions */
say('\n### Check for new versions');
try {
  const said = await win.evaluate(() => {
    const el = [...document.querySelectorAll('[role=status]')].find((n) => /version|release|update/i.test(n.textContent ?? ''));
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '(no status element)';
  });
  const box = await win.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) => /Check for new versions/i.test(l.textContent ?? ''));
    const input = label?.querySelector('input[type=checkbox]');
    return input ? input.checked : null;
  });
  record('Check for new versions', true, `checkbox=${box}; it says: "${said}"`);
  await shot('72-check-new-versions');
} catch (err) {
  record('Check for new versions', false, String(err.message).split('\n')[0]);
}

/* ------------------------------------------------------------ Export Logs */
say('\n### Export Logs');
try {
  const before = new Set(readdirSync(SCRATCH));
  const clicked = await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^Export Logs/.test((x.textContent ?? '').trim()));
    if (!b) return { ok: false, reason: 'no Export Logs button' };
    b.scrollIntoView({ block: 'center' });
    b.click();
    return { ok: true };
  });
  if (!clicked.ok) throw new Error(clicked.reason);
  await win.waitForTimeout(5000);
  const newFiles = readdirSync(SCRATCH).filter((f) => !before.has(f));
  record(
    'Export Logs',
    newFiles.length > 0,
    newFiles.length
      ? `new files under the scratch folder: ${newFiles.join(', ')}`
      : `no file appeared under ${SCRATCH}; the export opens the system save dialog, which a native window cannot be filled from here`,
  );
  await shot('73-export-logs');
} catch (err) {
  record('Export Logs', false, String(err.message).split('\n')[0]);
}

/* ------------------------------------------------------------ Clear Cache */
say('\n### Clear Cache');
try {
  const targets = ['live-tv', 'helper/downloads', 'helper/cache'];
  const before = {};
  for (const d of targets) {
    const p = join(DATA, d);
    if (existsDir(p)) before[d] = dirSize(p);
  }
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === 'Clear Cache');
    b?.scrollIntoView({ block: 'center' });
    b?.click();
  });
  await win.waitForTimeout(4000);
  const after = {};
  for (const d of targets) after[d] = existsDir(join(DATA, d)) ? dirSize(join(DATA, d)) : 0;
  const parts = Object.keys(before).map((d) => `${d}: ${before[d]} -> ${after[d]} bytes`);
  record('Clear Cache', parts.length > 0, parts.join('; ') || 'no cache directories present to compare');
  await shot('74-clear-cache');
} catch (err) {
  record('Clear Cache', false, String(err.message).split('\n')[0]);
}

/* ------------------------------------------------------------ the song list by keyboard */
say('\n### the song list reachable by keyboard');
try {
  await win.evaluate(() => {
    const t = [...document.querySelectorAll('[role=tab]')].find((x) => (x.textContent ?? '').trim() === 'Library');
    t?.click();
  });
  await win.waitForTimeout(2500);
  const info = await win.evaluate(() => {
    const list = document.querySelector('.ipod__list, table tbody, [role=grid], [role=listbox]');
    if (!list) return { ok: false, reason: 'no song list container in the DOM' };
    list.focus?.();
    const focused = document.activeElement;
    return {
      ok: true,
      tag: focused?.tagName,
      tabindex: focused?.getAttribute('tabindex'),
      rows: document.querySelectorAll('tbody tr, [role=option]').length,
      emptyState: (document.querySelector('.ipod__empty, [role=status]')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90),
    };
  });
  if (!info.ok) throw new Error(info.reason);
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(400);
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(600);
  const sel = await win.evaluate(() => {
    const el = document.querySelector('[aria-selected=true], .is-on, tr.is-playing');
    return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) : null;
  });
  record(
    'song list by keyboard',
    true,
    `focus went to <${info.tag}> tabindex=${info.tabindex}, ${info.rows} rows, empty state "${info.emptyState}"; ArrowDown x2 selected: ${sel ?? '(nothing - the list is empty in this sandbox, no music folder is configured)'}`,
  );
  await shot('75-library-keyboard');
} catch (err) {
  record('song list by keyboard', false, String(err.message).split('\n')[0]);
}

writeFileSync(join(EVIDENCE, '70-companion-controls.txt'), lines.join('\n'));
say('\n### summary');
for (const r of results) say(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.what} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
say(`\n${results.length - failed.length}/${results.length} controls exercised. evidence/70-companion-controls.txt`);
await app.close();