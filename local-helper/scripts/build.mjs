/**
 * Bundle the helper into one file.
 *
 * One file is the point. Someone downloads `now-playing-helper.mjs`, puts it beside
 * `now-playing.html`, runs `node now-playing-helper.mjs`, and has the player with the tools wired
 * up — no install, no container, no package manager. Anything that made this a directory of
 * modules would take that away.
 *
 * Nothing is external: there are no native modules here, and the only dependencies are the
 * workspace's own schemas, which bundle to a few kilobytes.
 *
 * The finished file is also copied to `local-helper/now-playing-helper.mjs`, where it is committed
 * — exactly as `now-playing.html` is committed at the repository root, and for the same reason. The
 * README tells people to download that one file and run it; `dist/` is git-ignored and nothing
 * published it, so the instruction pointed at a file that did not exist anywhere they could reach.
 * `pnpm verify`'s `helper-up-to-date` gate rebuilds to a temporary directory and compares, so the
 * committed copy cannot drift from the source.
 *
 * With no argument it writes both. Given a directory it writes only there, which is what the gate
 * uses so it never dirties the working tree.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const override = process.argv[2] ? resolve(process.argv[2]) : null;
const dist = override ?? join(root, 'dist');
if (!override) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const outfile = join(dist, 'now-playing-helper.mjs');
await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  minify: false,
  define: { 'process.env.NP_VERSION': JSON.stringify(pkg.version) },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});

const sizeKb = Math.round(statSync(outfile).size / 1024);
if (override) {
  process.stdout.write(`Built ${pkg.name} ${pkg.version} into ${outfile} (${sizeKb}KB)` + String.fromCharCode(10));
} else {
  // The committed copy people are actually told to download.
  copyFileSync(outfile, join(root, 'now-playing-helper.mjs'));
  process.stdout.write(`Built ${pkg.name} ${pkg.version} into dist/ and local-helper/now-playing-helper.mjs (${sizeKb}KB)` + String.fromCharCode(10));
}
