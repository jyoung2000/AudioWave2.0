/**
 * The data directory must exist and be writable before anything else is built on it.
 *
 * Docker creates a missing bind-mount source owned by root, while the image runs as uid 1000, so a
 * directory nobody prepared shows up here as "cannot write". Checking first turns what used to be a
 * database error deep inside startup into one plain sentence that names the directory and the fix.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureWritableDataDir(dir: string): void {
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    throw new Error(
      `The hub cannot write to its data directory ${dir} (${code}). ` +
        (process.env['NP_CONTAINER'] === '1'
          ? `It is the ./data folder next to compose.yaml, and the hub runs as uid ${uid}. ` +
            `Run \`./nowplaying install\` once, or on Linux: sudo chown -R 1000:1000 ./data — then start the hub again.`
          : `Point NP_DATA_DIR at a folder this user can write, or fix its permissions (on Linux: sudo chown -R 1000:1000 ${dir}).`),
      { cause: err },
    );
  }
}
