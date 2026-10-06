/**
 * The browser the mockups are rendered in, and the app builds it renders.
 *
 * Every app is built by its own Vite configuration into a scratch folder and served to the page by
 * Playwright's request routing — no server, no port, nothing listening. The page's origin is a
 * loopback address (a secure context, as the real apps get), but no request ever reaches the
 * network: anything that is neither the build nor a recorded answer is aborted and reported.
 *
 * Time is Playwright's installed clock (see session.mjs), the locale, the time zone and the viewport are fixed, and
 * `Math.random` is seeded, so the same sources render the same markup on every run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const require = createRequire(join(ROOT, 'package.json'));

/** The installed Chrome where there is one (this machine has no Playwright Chromium), else Playwright's. */
export function browserPath() {
  const named = process.env.NP_MOCKUP_BROWSER || process.env.NP_STYLEGUIDE_BROWSER || process.env.PW_CHROMIUM_PATH;
  if (named) return named;
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function launch() {
  const { chromium } = require('@playwright/test');
  const executablePath = browserPath();
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    // Software WebGL, so the player's disc draws the same on every machine that has this Chrome.
    args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
  });
}

/** Build one app with its own Vite config into a scratch folder. Returns the folder. */
export async function viteBuild({ configFile, root, label }) {
  // For working on a mockup's script: reuse a build made earlier (it is not removed afterwards).
  const reuse = process.env[`NP_MOCKUP_DIST_${label.toUpperCase()}`];
  if (reuse) return reuse;
  const { build } = await import('vite');
  const outDir = mkdtempSync(join(tmpdir(), `np-mockup-${label}-`));
  await build({
    configFile: join(ROOT, configFile),
    ...(root ? { root: join(ROOT, root) } : {}),
    logLevel: 'error',
    build: { outDir, emptyOutDir: true, sourcemap: false, reportCompressedSize: false },
  });
  return outDir;
}

export function removeDir(dir) {
  if (Object.entries(process.env).some(([key, value]) => key.startsWith('NP_MOCKUP_DIST_') && value === dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may hold a file for a moment; the folder is in the temp directory.
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Answer a request for `origin/<path>` from a built folder. */
export function fileResponse(dir, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  dir = resolve(dir);
  const file = join(dir, rel);
  if (!file.startsWith(dir) || !existsSync(file)) return null;
  return { status: 200, headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }, body: readFileSync(file) };
}

/** Deterministic `Math.random`, installed before any app script runs. */
export const SEEDED_RANDOM = `(() => {
  let s = 0x2f6b9c1d;
  Math.random = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (window.crypto && crypto.getRandomValues) {
    // Ids built from random bytes (UUIDv7 rows, request ids) come out the same on every run.
    crypto.getRandomValues = function (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      return array;
    };
  }
  if (window.crypto && crypto.randomUUID) {
    let n = 0;
    crypto.randomUUID = () => { n += 1; const h = n.toString(16).padStart(12, '0'); return '00000000-0000-4000-8000-' + h; };
  }
})();`;

/**
 * A fresh page on a fixed clock. `routes(route, url)` answers what the app asks for; returning
 * false leaves the request to the default (aborted and recorded in `unanswered`).
 */
export async function openPage(browser, { viewport, locale, timezoneId, origin, dist, routes, init = [] }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale,
    timezoneId,
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.addInitScript(SEEDED_RANDOM);
  for (const script of init) await page.addInitScript(script);
  const errors = [];
  const unanswered = new Set();
  page.on('pageerror', (error) => errors.push(error.message.slice(0, 300)));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (routes) {
      const answered = await routes(route, url);
      if (answered) return;
    }
    if (url.origin === origin && dist) {
      const file = fileResponse(dist, url.pathname);
      if (file) return route.fulfill(file);
    }
    unanswered.add(`${route.request().method()} ${url.origin === origin ? url.pathname + url.search : url.href}`);
    return route.abort();
  });
  return { context, page, errors, unanswered };
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
