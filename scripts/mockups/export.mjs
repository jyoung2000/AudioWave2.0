/**
 * `pnpm mockups:export <dir>` — copy the three living mockups (design/frontends/airwave-*.html) to a
 * folder of your own, for opening, sharing or editing outside the repository. It copies what is
 * committed; run `pnpm mockups:build` first if the apps have changed since. Edited copies come back
 * with `pnpm mockups:diff <app> --mockups <dir>`.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APPS, MOCKUP_DIR } from './build.mjs';
import { ROOT } from './lib/browser.mjs';

export async function main(argv) {
  const target = argv.find((arg) => !arg.startsWith('--'));
  if (!target) {
    console.error('usage: pnpm mockups:export <folder>');
    return 2;
  }
  const dir = resolve(process.cwd(), target);
  mkdirSync(dir, { recursive: true });
  for (const app of Object.values(APPS)) {
    const from = join(ROOT, MOCKUP_DIR, app.file);
    if (!existsSync(from)) throw new Error(`${from} does not exist — run pnpm mockups:build`);
    copyFileSync(from, join(dir, app.file));
    console.info(`${app.title}: ${join(dir, app.file)}`);
  }
  return 0;
}
