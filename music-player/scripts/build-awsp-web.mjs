#!/usr/bin/env node
/**
 * Build the PWA's AWSP client (music-player/awsp-web, Rust → wasm32) into
 * music-player/src/shell/awsp-web/, where the dedicated worker imports it.
 *
 *   node music-player/scripts/build-awsp-web.mjs        (or: pnpm --filter @now-playing/music-player build:awsp-web)
 *
 * The output — `awsp_web.js` (the wasm-bindgen glue), `awsp_web_bg.wasm` and their `.d.ts` — is
 * committed, about 2.3 MB, so `pnpm build` and every test work on a machine with no Rust toolchain.
 * `SOURCES.sha256` records the hash of the crate's sources it was built from; the unit test
 * `tests/unit/awsp-web-artefact.test.ts` fails when the sources move on without a rebuild.
 *
 * Needs: cargo with the wasm32-unknown-unknown target, wasm-bindgen-cli =0.2.122 (the crate pins the
 * same version), and a C compiler for wasm32 — `ring` compiles a little C. That is clang on PATH,
 * or `CC_wasm32_unknown_unknown`, or zig (`AWSP_ZIG`, or `zig` on PATH), used through
 * scripts/zig-cc.mjs. `wasm-opt` is used when present and skipped when not.
 *
 * Without cargo it says so and exits 0: the committed build is used as it is.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awspWebSourceHash } from './awsp-web-hash.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, '..', 'awsp-web');
const out = join(here, '..', 'src', 'shell', 'awsp-web');
const exe = process.platform === 'win32' ? '.exe' : '';
const cargoHome = process.env['CARGO_HOME'] ?? join(homedir(), '.cargo');

function tool(name) {
  const onPath = spawnSync(name, ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return name;
  const local = join(cargoHome, 'bin', name + exe);
  return existsSync(local) ? local : null;
}

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) {
    console.error(`${cmd} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

const cargo = tool('cargo');
if (!cargo) {
  console.log('build-awsp-web: cargo is not installed; the committed build in src/shell/awsp-web is used as it is.');
  process.exit(0);
}
const bindgen = tool('wasm-bindgen');
if (!bindgen) {
  console.error('build-awsp-web: wasm-bindgen is missing — `cargo install wasm-bindgen-cli --version =0.2.122`');
  process.exit(1);
}
const bindgenVersion = spawnSync(bindgen, ['--version'], { encoding: 'utf8' }).stdout.trim();
if (!bindgenVersion.endsWith('0.2.122')) {
  console.error(`build-awsp-web: ${bindgenVersion} does not match the crate's wasm-bindgen =0.2.122`);
  process.exit(1);
}

// A C compiler for wasm32. clang first; failing that, zig through the translating shim.
const env = { ...process.env };
const hasClang = spawnSync('clang', ['--version'], { stdio: 'ignore' }).status === 0;
if (!hasClang && !env['CC_wasm32_unknown_unknown']) {
  const zig = env['AWSP_ZIG'] || (spawnSync('zig', ['version'], { stdio: 'ignore' }).status === 0 ? 'zig' : null);
  if (!zig) {
    console.error('build-awsp-web: ring needs a C compiler for wasm32 — install clang (LLVM) or zig, or set AWSP_ZIG');
    process.exit(1);
  }
  const shims = join(crate, 'target', 'shims');
  mkdirSync(shims, { recursive: true });
  const script = join(here, 'zig-cc.mjs');
  for (const mode of ['cc', 'ar']) {
    const file = join(shims, `zig-${mode}${process.platform === 'win32' ? '.cmd' : ''}`);
    writeFileSync(file, process.platform === 'win32' ? `@"${process.execPath}" "${script}" ${mode} %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" ${mode} "$@"\n`, { mode: 0o755 });
    env[mode === 'cc' ? 'CC_wasm32_unknown_unknown' : 'AR_wasm32_unknown_unknown'] = file;
  }
  env['AWSP_ZIG'] = zig;
  console.log(`build-awsp-web: no clang; compiling ring's C with ${zig}`);
}

// cwd is the crate, so its .cargo/config.toml (target and the getrandom backend) applies.
run(cargo, ['build', '--release', '--locked'], { cwd: crate, env });
const wasm = join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'awsp_web.wasm');
const staged = join(crate, 'target', 'pkg');
run(bindgen, [wasm, '--out-dir', staged, '--target', 'web', '--weak-refs']);
const opt = tool('wasm-opt');
if (opt) run(opt, ['--enable-nontrapping-float-to-int', '--enable-bulk-memory', '-Os', '-o', join(staged, 'awsp_web_bg.wasm'), join(staged, 'awsp_web_bg.wasm')]);
else console.log('build-awsp-web: wasm-opt not found; the wasm is not post-optimised');

mkdirSync(out, { recursive: true });
for (const f of ['awsp_web.js', 'awsp_web.d.ts', 'awsp_web_bg.wasm', 'awsp_web_bg.wasm.d.ts']) copyFileSync(join(staged, f), join(out, f));
writeFileSync(join(out, 'SOURCES.sha256'), awspWebSourceHash() + '\n');
console.log(`build-awsp-web: wrote ${out}`);
