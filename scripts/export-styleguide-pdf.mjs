#!/usr/bin/env node
/**
 * `pnpm styleguide:pdf` — print docs/design/styleguide.html to docs/design/styleguide.pdf.
 *
 * The page designs its own print layout (cover, contents, chapters, every mockup screen); this
 * script only opens it, asks the mockups for their print matrix, waits until every frame has been
 * measured, and prints. It uses the Playwright Chromium the e2e suites already use, or the browser
 * named by NP_STYLEGUIDE_BROWSER. It never downloads anything.
 *
 * Adapted from the living-style-guide skill's export_pdf.mjs.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function parse(argv) {
  const options = { html: 'docs/design/styleguide.html', out: 'docs/design/styleguide.pdf', timeout: '120000' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help') return null;
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--') || !(key in options) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${flag}`);
    options[key] = argv[++i];
  }
  return options;
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function main() {
  const options = parse(process.argv.slice(2));
  if (!options) {
    console.log(
      'Usage: node scripts/export-styleguide-pdf.mjs [--html docs/design/styleguide.html] [--out docs/design/styleguide.pdf] [--timeout 120000]\nSet NP_STYLEGUIDE_BROWSER to a Chromium, Chrome or Edge executable to use it instead of Playwright’s.',
    );
    return;
  }
  const html = resolve(root, options.html);
  const out = resolve(root, options.out);
  const timeout = Number(options.timeout);
  const source = await readFile(html, 'utf8');
  const fingerprint = /<meta name="styleguide-fingerprint" content="([0-9a-f]+)"/.exec(source)?.[1] ?? 'unknown';

  const require = createRequire(resolve(root, 'package.json'));
  const { chromium } = require('@playwright/test');
  const executablePath = process.env.NP_STYLEGUIDE_BROWSER || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
    page.setDefaultTimeout(timeout);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.waitForSelector('html[data-styleguide-ready="true"]', { state: 'attached' });
    await page.emulateMedia({ media: 'print', reducedMotion: 'reduce', colorScheme: 'light' });
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((item) => {
        item.open = true;
      });
      window.dispatchEvent(new Event('sg:print'));
    });
    await page.waitForSelector('html[data-styleguide-print-ready="true"]', { state: 'attached', timeout });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    if (failures.length) throw new Error(`The styleguide reported errors while rendering:\n${[...new Set(failures)].join('\n')}`);

    const label = escapeHtml(`Now Playing styleguide · source ${fingerprint}`);
    const footer = `<div style="font:8px Helvetica,Arial,sans-serif;color:#6b7075;width:100%;margin:0 15mm;display:flex;justify-content:space-between"><span>${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
    const bytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
      margin: { top: '15mm', bottom: '18mm', left: '15mm', right: '15mm' },
      outline: true,
      tagged: true,
      timeout,
    });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    console.log(JSON.stringify({ output: out, bytes: bytes.length, fingerprint }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`Styleguide PDF: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
