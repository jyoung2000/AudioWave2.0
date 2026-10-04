#!/usr/bin/env node
/**
 * §2.12 — Export Logs: what would actually be in the zip.
 *
 * Exporting through the button opens Windows' own save dialog, which this harness cannot answer:
 * `dialog.showSaveDialog` blocks Electron's main thread (windows-companion/src/main/index.ts:525),
 * so while it is up the companion's window does not appear in the UI Automation tree at all and there
 * is nothing for a second process to drive. Rather than claim the button works, this runs the
 * companion's OWN redaction function — the one `exportLogs` applies to every log file and to
 * about.txt before zipping (windows-companion/src/main/log.ts:197-202) — against the real log on
 * disk and the real helper token, read out of the running companion.
 *
 * So §2.12's actual question is answered directly: does a token, a Bearer value, or a folder path
 * from this machine survive into what gets written?
 *
 *   node .agents/evidence/harness/export-logs.mjs
 */
import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/* ------------------------------------------------------------ the companion's own redactLog */
// Loaded out of the SHIPPED bundle rather than from a copy of the source, so what runs here is the
// code the packaged app runs.
const bundle = readFileSync(join(CLONE, 'windows-companion', 'dist', 'main', 'index.cjs'), 'utf8');
const take = (from, marker) => {
  const i = bundle.indexOf(marker, from);
  if (i < 0) throw new Error(`could not find ${marker} in the bundle`);
  let depth = 0;
  for (let j = bundle.indexOf('{', i); j < bundle.length; j++) {
    if (bundle[j] === '{') depth++;
    else if (bundle[j] === '}') {
      depth--;
      if (depth === 0) return bundle.slice(i, j + 1);
    }
  }
  throw new Error(`unterminated ${marker}`);
};
const start = bundle.indexOf('function redactLog(text');
if (start < 0) {
  say('FAIL the built bundle no longer contains redactLog — this harness needs updating');
  process.exit(2);
}
// redactLog is self-contained: it calls only `escape`, which is bundled alongside it.
const src = [take(0, 'function escape('), take(start, 'function redactLog(text'), 'export { redactLog };'].join('\n');
const { redactLog } = await import(`data:text/javascript,${encodeURIComponent(src)}`);
say(`loaded redactLog out of the shipped bundle (${src.length} chars of the built main process)`);

/* ------------------------------------------------------------ the real token, from the real app */
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
await win.waitForTimeout(2500);
const token = await win.evaluate(async () => {
  try {
    const r = await window.companion.invoke('helper:token');
    return typeof r?.token === 'string' ? r.token : null;
  } catch {
    return null;
  }
});
say(`helper token read through the companion's own bridge: ${token ? 'yes (never printed, never written)' : 'NO'}`);

/* ------------------------------------------------------------ the real logs, redacted for real */
const logDir = join(SCRATCH, 'NowPlayingCompanion-data', 'logs');
const logFiles = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('.log')) : [];
say(`\nlog files present: ${logFiles.length ? logFiles.join(', ') : '(none)'}`);

// Planted lines carrying every one of the things the brief worries about, so this is not merely
// "the real log happened not to contain them".
const fallback = 'abcdef0123456789abcdef0123456789';
const value = token ?? fallback;
const probe = [
  `2026-10-04T00:00:00Z INFO [helper] token=${value}`,
  `2026-10-04T00:00:01Z INFO [helper] Authorization: Bearer ${value}`,
  `2026-10-04T00:00:02Z INFO [paths] wrote ${SCRATCH}\\NowPlayingCompanion-data\\helper\\tools\\yt-dlp.exe`,
  `2026-10-04T00:00:03Z INFO [paths] also C:\\Users\\owner\\Documents\\airwave-companion-logs.zip`,
  `2026-10-04T00:00:04Z INFO [helper] helper listening at http://127.0.0.1:${process.env.NP_HELPER_PORT ?? 17342}`,
  '2026-10-04T00:00:05Z INFO [secret] password=correct-horse-battery-staple credential:abc123def456',
].join('\n');
const real = logFiles.map((f) => readFileSync(join(logDir, f), 'utf8')).join('\n');
const input = `${real}\n${probe}`;
say(`\n### redacting ${input.length} chars: the real log, plus six planted lines carrying a token, a`);
say('### Bearer value, a folder path, a password and a credential');

const output = redactLog(input, token ? [token] : [], 'C:\\Users\\owner');
say(`### redacted output: ${output.length} chars`);

say('\n### what must NOT survive');
const checks = [
  ['the exact helper token', () => output.includes(value)],
  ['any Bearer value with 8+ chars after it', () => /Bearer\s+[A-Za-z0-9._-]{8,}/i.test(output)],
  ['this scratch folder path', () => /np-prove/i.test(output)],
  ["the owner's home folder name", () => /owner/i.test(output)],
  ['a password assignment', () => /password\s*[:=]\s*(?!\[secret\])\S+/i.test(output)],
  ['a credential assignment', () => /credential\s*[:=]\s*(?!\[secret\])\S+/i.test(output)],
];
let leaked = 0;
for (const [name, fails] of checks) {
  const bad = fails();
  if (bad) leaked++;
  say(`  ${bad ? 'LEAKED   ' : 'redacted'}  ${name}`);
}

say('\n### what those planted lines actually read after redaction');
for (const line of output.split('\n').filter((l) => /token=|Bearer|password=|credential:|listening at|wrote /.test(l))) {
  say(`  ${line.trim().slice(0, 130)}`);
}

say(`\nVERDICT: ${leaked === 0 ? 'nothing sensitive survives redaction' : `${leaked} of ${checks.length} checks LEAKED`}`);
writeFileSync(join(EVIDENCE, '73-export-logs.txt'), lines.join('\n'));
say('evidence: evidence/73-export-logs.txt');
await app.close();