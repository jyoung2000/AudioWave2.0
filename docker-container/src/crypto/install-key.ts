import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RandomSource } from '../deps.js';

export const INSTALL_KEY_BYTES = 32;

/**
 * Loads (or creates on first run) the per-installation key that seals provider secrets, user tokens and the Discord token.
 * The key lives outside the database so a copy of the database alone exposes nothing.
 */
export function loadOrCreateInstallKey(file: string, random: RandomSource): Uint8Array {
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    if (bytes.length !== INSTALL_KEY_BYTES) throw new Error(`Installation key ${file} must be exactly ${INSTALL_KEY_BYTES} bytes (got ${bytes.length})`);
    try {
      const mode = statSync(file).mode & 0o777;
      if (mode & 0o077) chmodSync(file, 0o600);
    } catch {
      /* permissions are best effort on non-POSIX filesystems */
    }
    return new Uint8Array(bytes);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = random.bytes(INSTALL_KEY_BYTES);
  writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}
