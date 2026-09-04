/**
 * Bundle the hub into a small set of files under `dist/`.
 *
 * Two things are deliberate. `better-sqlite3` stays external because it is a native module — a
 * bundler can only break it. And the migrations directory is copied verbatim rather than inlined,
 * so an operator can read exactly what schema their data went through.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** Native modules and anything that reads its own package layout at runtime. */
const external = ['better-sqlite3', 'music-metadata', '@node-rs/argon2', 'discord.js', '@discordjs/voice', 'opusscript', 'pino', 'fastify', '@fastify/static', 'ws', 'qrcode'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  external,
  define: { 'process.env.NP_VERSION': JSON.stringify(pkg.version) },
  // Node ESM cannot resolve `require` from a bundled file; give the banner the shim it needs.
  banner: { js: "import { createRequire as __npCreateRequire } from 'node:module';\nconst require = __npCreateRequire(import.meta.url);\n" },
  logLevel: 'info',
};

await build({ ...common, entryPoints: [join(root, 'src/server.ts')], outfile: join(dist, 'server.js') });
await build({ ...common, entryPoints: [join(root, 'src/discord/worker.ts')], outfile: join(dist, 'discord-worker.js') });
await build({ ...common, entryPoints: [join(root, 'src/db/migrate-cli.ts')], outfile: join(dist, 'migrate.js') });

cpSync(join(root, 'migrations'), join(dist, 'migrations'), { recursive: true });

// A runtime package.json with only the dependencies that stayed external, so the image installs
// the smallest possible tree.
const runtimeDeps = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([name]) => external.includes(name)));
writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', main: 'server.js', dependencies: runtimeDeps }, null, 2)}\n`,
);

process.stdout.write(`Built ${pkg.name} ${pkg.version} into dist/ (${Object.keys(runtimeDeps).length} runtime dependencies)\n`);
