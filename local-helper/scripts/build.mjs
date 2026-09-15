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
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
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

process.stdout.write(`Built ${pkg.name} ${pkg.version} into dist/now-playing-helper.mjs (${Math.round(statSync(outfile).size / 1024)}KB)\n`);
