#!/usr/bin/env node
/**
 * `zig cc` / `zig ar` standing in for clang when building `awsp-web` for wasm32 on a machine
 * without LLVM (build-awsp-web.mjs writes a .cmd shim that calls this).
 *
 * `ring` compiles a little C for wasm32-unknown-unknown and cc-rs asks for `clang`. Zig bundles
 * clang but names the target differently, so the one argument that differs is translated:
 * `--target=wasm32-unknown-unknown` becomes `-target wasm32-freestanding`. Everything else passes
 * through unchanged.
 *
 * Usage: node zig-cc.mjs <cc|ar> …args     (the zig executable is AWSP_ZIG, or `zig` on PATH)
 */
import { spawnSync } from 'node:child_process';

const [mode, ...rest] = process.argv.slice(2);
const zig = process.env['AWSP_ZIG'] || 'zig';
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--target=wasm32-unknown-unknown' || a === '--target=wasm32') args.push('-target', 'wasm32-freestanding');
  else if ((a === '--target' || a === '-target') && /^wasm32/.test(rest[i + 1] ?? '')) {
    args.push('-target', 'wasm32-freestanding');
    i++;
  } else args.push(a);
}
const r = spawnSync(zig, [mode === 'ar' ? 'ar' : 'cc', ...args], { stdio: 'inherit' });
process.exit(r.status ?? 1);
