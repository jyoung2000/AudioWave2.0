/**
 * Build the Electron main process and the preload script.
 *
 * Both are emitted as CommonJS with a `.cjs` extension. That is not nostalgia: the package is
 * `"type": "module"`, Electron's preload runs in a context that has no ESM loader, and the main
 * process needs `require` for the native SQLite binding. A `.cjs` extension states the format in
 * the filename so Node never has to guess.
 *
 * The renderer is built separately by Vite (see `src/renderer/vite.config.ts`) — it is ordinary
 * web code and has no business being bundled with anything that can touch the filesystem.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist', 'main');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

/**
 * `electron` is provided by the runtime, and `better-sqlite3` is a native `.node` binding that a
 * bundler can only corrupt. electron-builder unpacks both from the asar archive.
 */
const external = ['electron', 'better-sqlite3'];

const common = {
  bundle: true,
  platform: 'node',
  // Electron 44 ships Node 22 and Chromium 132; targeting the pair avoids downlevelling code that
  // both ends already understand.
  target: ['node22', 'chrome132'],
  format: 'cjs',
  sourcemap: true,
  minify: false,
  external,
  define: {
    'process.env.NP_VERSION': JSON.stringify(pkg.version),
    /*
     * Whether *this* build was signed, decided here and baked in.
     *
     * It used to be `process.env.NP_SIGNED === '1'` read at runtime, on the user's machine, where
     * the variable is whatever their environment happens to hold — so an unsigned build could claim
     * to be signed simply because someone had exported it, and a signed one could deny it. The only
     * place that knows the answer is the build, and the CI release job is what sets
     * `NP_RELEASE_SIGNED`.
     */
    __NP_SIGNED__: JSON.stringify(process.env.NP_RELEASE_SIGNED === '1' || process.env.NP_RELEASE_SIGNED === 'true'),
  },
  logLevel: 'info',
};

await build({ ...common, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(outDir, 'index.cjs') });
// The preload is the security boundary; it is bundled separately so nothing from the main process
// can be reached through a shared module instance.
await build({ ...common, entryPoints: [join(root, 'src/preload/index.ts')], outfile: join(outDir, 'preload.cjs') });

process.stdout.write(`Built ${pkg.name} ${pkg.version} main process into dist/main/\n`);
