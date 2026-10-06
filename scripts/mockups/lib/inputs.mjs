/**
 * What each mockup is made from, as one hash (`<meta name="mockup-inputs">`).
 *
 * `pnpm styleguide:check` compares it with the sources as they are now — a cheap, browser-free
 * check that runs everywhere, CI included. `pnpm verify`'s `mockups-up-to-date` is the strict one:
 * it renders the mockups again and compares them with the committed files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);

function walk(root, rel, out) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(rel.split(sep).join('/'));
    return;
  }
  for (const name of readdirSync(abs).sort()) if (!SKIP.has(name)) walk(root, join(rel, name), out);
}

/** The tooling and fixtures every mockup is rendered with. */
export const COMMON_INPUTS = ['scripts/mockups'];

export function inputsHash(root, inputs) {
  const files = [];
  for (const input of [...COMMON_INPUTS, ...inputs]) walk(root, input, files);
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
