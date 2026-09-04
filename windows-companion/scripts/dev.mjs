/**
 * Development runner: Vite serves the interface, esbuild watches the main process, Electron loads
 * from the dev server.
 *
 * The dev server URL is passed through `NP_DEV_SERVER_URL` and read once in `src/main/index.ts`.
 * That single variable is the only difference between a development window and a packaged one, so
 * there is no `isDev` branching scattered through the app deciding what is allowed.
 */
import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const server = await createServer({ configFile: join(root, 'src/renderer/vite.config.ts') });
await server.listen();
const address = server.resolvedUrls?.local[0];
if (!address) throw new Error('The dev server did not report a local address');
server.printUrls();

const common = {
  bundle: true,
  platform: 'node',
  target: ['node22', 'chrome132'],
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
};

const main = await context({ ...common, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(root, 'dist/main/index.cjs') });
const preload = await context({ ...common, entryPoints: [join(root, 'src/preload/index.ts')], outfile: join(root, 'dist/main/preload.cjs') });
await main.rebuild();
await preload.rebuild();
await main.watch();
await preload.watch();

const electronBin = (await import('electron')).default;
const child = spawn(electronBin, [root], {
  stdio: 'inherit',
  env: { ...process.env, NP_DEV_SERVER_URL: address.replace(/\/$/, '') },
});

const shutdown = async () => {
  await main.dispose();
  await preload.dispose();
  await server.close();
};

child.on('exit', async (code) => {
  await shutdown();
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
  });
}
