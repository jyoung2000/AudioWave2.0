#!/usr/bin/env node
/**
 * Launches the packaged Airwave Companion inside the proof sandbox.
 *
 *   PORTABLE_EXECUTABLE_DIR=<scratch>   -> its settings/profile live in the scratch folder, never
 *                                           in the owner's real %APPDATA%\now-playing-companion
 *   NP_DATA_DIR=<scratch>\hub           -> never another clone's docker-container/data
 *   PATH without any ffmpeg directory    -> §2.4: FFmpeg is not on its PATH, so it must set FFmpeg
 *                                           up by itself
 *
 * Machine paths come from NP_SCRATCH / NP_CLONE; nothing is hard-coded. The script prints the
 * launcher PID it started so the caller records exactly that and stops only that.
 *
 * Usage:
 *   node .agents/evidence/harness/start-companion.mjs [--no-ffmpeg] [--helper-port 17342] [-- <extra electron args>]
 *   node .agents/evidence/harness/start-companion.mjs --wait-title "Airwave Companion"
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
if (!SCRATCH || !CLONE) {
  console.error('NP_SCRATCH and NP_CLONE must be set');
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const noFfmpeg = flag('--no-ffmpeg');
const helperPort = opt('--helper-port', '17342');
const extraArgs = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : [];

// The packaged app: `pnpm build:windows` copies it next to the app.asar.
const winDir = join(CLONE, 'windows-companion');
const candidates = [
  join(winDir, 'release', 'win-unpacked'),
  join(winDir, 'dist', 'win-unpacked'),
  join(winDir, 'out', 'win-unpacked'),
];
const root = candidates.find((d) => existsSync(join(d, 'Airwave Companion.exe')));
if (!root) {
  console.error('No packaged companion found. Run `pnpm build:windows` first.');
  console.error('Looked in:\n  ' + candidates.join('\n  '));
  process.exit(3);
}
const exe = join(root, 'Airwave Companion.exe');

// A PATH with every directory that holds an ffmpeg binary removed, so §2.4 can prove the
// companion fetches FFmpeg itself. Nothing is uninstalled or moved.
function stripFfmpegDirs(pathValue, extraStrips = []) {
  const removed = [];
  const kept = pathValue
    .split(';')
    .filter(Boolean)
    .filter((dir) => {
      const f = join(dir, 'ffmpeg.exe');
      if (existsSync(f) || extraStrips.some((s) => dir.toLowerCase().includes(s))) {
        removed.push(dir);
        return false;
      }
      return true;
    });
  return { path: kept.join(';'), removed };
}

const env = { ...process.env };
const notes = [];
env.PORTABLE_EXECUTABLE_DIR = SCRATCH;
env.NP_DATA_DIR = join(SCRATCH, 'hub');
if (noFfmpeg) {
  const before = (env.PATH || '').split(';').filter(Boolean);
  const { path, removed } = stripFfmpegDirs(env.PATH || '');
  env.PATH = path;
  notes.push(`ffmpeg-stripped-from-PATH: ${removed.length} director(ies) removed`);
  for (const d of before) if (!env.PATH.split(';').includes(d)) notes.push(`  removed ${d}`);
}
env.NP_HELPER_PORT = helperPort;
if (process.env.NP_EXTRA_PATH_PREFIX) env.PATH = `${process.env.NP_EXTRA_PATH_PREFIX};${env.PATH}`;

console.log(`root:    ${root}`);
console.log(`exe:     ${exe}`);
console.log(`scratch: ${SCRATCH}  (PORTABLE_EXECUTABLE_DIR)`);
console.log(`data:    ${env.NP_DATA_DIR}  (NP_DATA_DIR)`);
console.log(`helper:  ${helperPort}`);
for (const n of notes) console.log(n);
console.log(`PATH entries: ${env.PATH.split(';').length}`);

const child = spawn(exe, extraArgs, { env, detached: false, stdio: 'inherit' });
console.log(`LAUNCHED_PID=${child.pid}`);
child.on('exit', (code, sig) => console.log(`companion exited code=${code} signal=${sig}`));