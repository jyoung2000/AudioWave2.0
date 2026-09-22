/**
 * The hash of the awsp-web crate's sources: Cargo.toml, Cargo.lock, .cargo/config.toml and src/**.
 * build-awsp-web.mjs records it beside the committed wasm; a unit test compares, so a change to the
 * crate that was not rebuilt is caught without compiling anything. Line endings are normalised so a
 * checkout with CRLF hashes the same.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const crate = join(dirname(fileURLToPath(import.meta.url)), '..', 'awsp-web');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

export function awspWebSourceHash() {
  const list = [join(crate, 'Cargo.toml'), join(crate, 'Cargo.lock'), join(crate, '.cargo', 'config.toml'), ...files(join(crate, 'src')).sort()];
  const h = createHash('sha256');
  for (const f of list) {
    h.update(relative(crate, f).split('\\').join('/') + '\0');
    h.update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return h.digest('hex');
}
