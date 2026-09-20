/**
 * Render the installable app icons from the committed SVGs.
 *
 * The SVGs are the source; the PNGs beside them are build outputs that happen to be committed,
 * because a manifest cannot point at an SVG for the maskable icon on Android. Re-run this after
 * editing either SVG — `pnpm verify`'s `icons-up-to-date` gate renders to a temporary directory and
 * compares, so a re-centred SVG with stale PNGs beside it is now a failing gate rather than an app
 * icon that quietly disagrees with itself.
 *
 * With no argument it writes into `public/`. Given a directory it writes there instead, which is how
 * that gate compares without dirtying the working tree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, '..', 'public');
const outDir = process.argv[2] ? resolve(process.argv[2]) : sourceDir;

const OUTPUTS = [
  { svg: 'icon.svg', png: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', png: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', png: 'icon-maskable-512.png', size: 512 },
  // Referenced by index.html. It was not generated here, so when icon.svg was re-centred this one
  // silently kept the old artwork — the same drift the gate now catches, one file further out.
  { svg: 'icon.svg', png: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch(process.env['PW_CHROMIUM_PATH'] ? { executablePath: process.env['PW_CHROMIUM_PATH'] } : {});
try {
  for (const output of OUTPUTS) {
    const svg = readFileSync(join(sourceDir, output.svg), 'utf8');
    const page = await browser.newPage({ viewport: { width: output.size, height: output.size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${output.size}px;height:${output.size}px}</style>${svg}`);
    writeFileSync(join(outDir, output.png), await page.screenshot({ omitBackground: true, type: 'png' }));
    await page.close();
    process.stdout.write(`Wrote public/${output.png} (${output.size}px) from ${output.svg}\n`);
  }
} finally {
  await browser.close();
}
