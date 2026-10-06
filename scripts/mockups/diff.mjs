/**
 * `pnpm mockups:diff [player|hub|companion …] [--check] [--mockups <dir>]`
 *
 * What an edited mockup changes: the apps are rendered again into a scratch folder (exactly as
 * `pnpm mockups:build` would) and each mockup in design/frontends — or in `--mockups <dir>` — is
 * compared with that, section by section: the page around the states, each stylesheet (with the
 * line in its source file, since the block is a verbatim copy), and each state. Independent of git:
 * it compares with what the apps draw now, not with the last commit.
 *
 *   -  what the app draws now
 *   +  what the mockup says instead
 *
 * The same change made in several states is printed once, with the other states named. Canvas
 * pictures are not compared (they are photographs, not markup). `--check` exits 1 when anything
 * differs; `pnpm verify`'s `mockups-up-to-date` gate is exactly that.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { APPS, buildMockups, MOCKUP_DIR } from './build.mjs';
import { removeDir, ROOT } from './lib/browser.mjs';
import { sections } from './lib/document.mjs';
import { diffLines, hunks } from './lib/linediff.mjs';

/** The line in a stylesheet's source file where its verbatim copy starts. */
function sourceOffset(source, css) {
  const file = join(ROOT, source);
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf(css.slice(0, 2000));
  return at < 0 ? 0 : text.slice(0, at).split('\n').length - 1;
}

const label = (section) =>
  section.kind === 'state' ? `state "${section.id}" (${section.title})` : section.kind === 'stylesheet' ? `stylesheet ${section.source}` : section.title;

/** Compare one mockup with a fresh rendering. Returns { changes, report }. */
export function compareMockup(appId, edited, fresh) {
  const mine = sections(edited);
  const now = sections(fresh);
  const byKey = new Map(now.map((s) => [s.key, s]));
  const lines = [];
  const seen = new Map();
  let changes = 0;
  const pictures = [];

  for (const section of mine) {
    const current = byKey.get(section.key);
    byKey.delete(section.key);
    if (!current) {
      lines.push('', `── ${label(section)} — in the mockup, but the app no longer draws it`);
      changes += 1;
      continue;
    }
    if (section.kind === 'state' && section.pictures !== current.pictures) pictures.push(section.id);
    if (section.text === current.text) continue;
    const ops = diffLines(current.text.split('\n'), section.text.split('\n'));
    const offset = section.kind === 'stylesheet' ? sourceOffset(section.source, current.text) : 0;
    for (const hunk of hunks(ops)) {
      const signature = hunk.changed.map((l) => l.op + l.line).join('\n');
      const where = section.kind === 'stylesheet' ? `${section.source} line ${hunk.aStart + offset}` : `mockup line ${hunk.bStart + section.start - 1}`;
      if (section.kind === 'state' && seen.has(signature)) {
        seen.get(signature).also.push(section.id);
        continue;
      }
      changes += 1;
      const entry = { header: `── ${label(section)} · ${where}`, body: hunk.lines.map((l) => `${l.op} ${l.line}`), also: [] };
      if (section.kind === 'state') seen.set(signature, entry);
      lines.push(entry);
    }
  }
  for (const section of byKey.values()) {
    lines.push('', `── ${label(section)} — the app draws it now, but the mockup does not have it`);
    changes += 1;
  }
  const report = [];
  for (const item of lines) {
    if (typeof item === 'string') {
      report.push(item);
      continue;
    }
    report.push('', item.header, ...item.body);
    if (item.also.length) report.push(`   (the same change is also in: ${item.also.map((id) => `"${id}"`).join(', ')})`);
  }
  if (pictures.length) report.push('', `(canvas pictures differ in ${pictures.join(', ')}: photographs of what the app drew, not compared)`);
  return { changes, report: report.join('\n') };
}

export async function main(argv) {
  const check = argv.includes('--check');
  const at = argv.indexOf('--mockups');
  const mockups = resolve(ROOT, at >= 0 ? argv[at + 1] : MOCKUP_DIR);
  const names = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--mockups');
  const apps = names.length ? names : Object.keys(APPS);
  const scratch = mkdtempSync(join(tmpdir(), 'np-mockups-diff-'));
  let total = 0;
  try {
    await buildMockups(apps, scratch);
    for (const id of apps) {
      const app = APPS[id];
      const file = join(mockups, app.file);
      const shown = relative(ROOT, file).replace(/\\/g, '/');
      if (!existsSync(file)) {
        console.info(`\n${app.title}: ${shown} does not exist — run pnpm mockups:build ${id}`);
        total += 1;
        continue;
      }
      const edited = readFileSync(file, 'utf8');
      const fresh = readFileSync(join(scratch, app.file), 'utf8');
      const { changes, report } = compareMockup(id, edited, fresh);
      total += changes;
      // The stamp of what it was made from: an app change that draws nothing new still restamps it.
      const stamp = (text) => /<meta name="mockup-inputs" content="([^"]*)">/.exec(text)?.[1] ?? null;
      if (check && !changes && stamp(edited) !== stamp(fresh)) {
        console.info(`\n${app.title}: ${shown} draws the same, but was made from older sources (${stamp(edited)}, now ${stamp(fresh)}).`);
        total += 1;
      }
      console.info(`\n${'='.repeat(78)}\n${app.title}: ${shown} against what the app draws now — ${changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'no changes'}`);
      if (changes) console.info('  (- the app now   + the mockup)' + report);
    }
  } finally {
    removeDir(scratch);
  }
  if (check && total) {
    console.error(`\n${total} difference${total === 1 ? '' : 's'}: the mockups are not what the apps draw. Run pnpm mockups:build (or, if the mockup was edited on purpose, carry the edit into the app first — AGENTS.md, "Living mockups").`);
    return 1;
  }
  return 0;
}
