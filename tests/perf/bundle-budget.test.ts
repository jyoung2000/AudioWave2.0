/**
 * Performance budgets for what a browser has to download before anything works.
 *
 * These are measured from the built output, not guessed: the entry script and stylesheet that
 * `index.html` actually references, plus everything the page eagerly preloads. Lazily-imported
 * chunks are excluded on purpose — that is the whole point of splitting them — but the test also
 * checks that the *expensive* ones really did stay out of the entry, because a budget that only
 * counts bytes is passed by moving code around rather than by loading less of it.
 *
 * The budgets are deliberately close to the current numbers. A budget with slack is a budget nobody
 * notices breaking; when a change genuinely needs more, raising the number here is a decision
 * someone makes on purpose, in a diff, with a reason.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Bundle {
  name: string;
  distDir: string;
  html: string;
  /** Budget for what loads before first paint, in KB. */
  entryBudgetKb: number;
  /** Budget for everything the build emitted, in KB. */
  totalBudgetKb: number;
  /** Substrings that must not appear in the entry chunk: expensive things that must stay split. */
  mustBeSplit: string[];
}

const BUNDLES: Bundle[] = [
  {
    name: 'music-player',
    distDir: join(repoRoot, 'music-player', 'dist'),
    html: 'index.html',
    // The player is offline-first: this is what someone downloads on a phone before the first note.
    // Currently 613KB — the headroom is small on purpose (see the note at the top).
    entryBudgetKb: 620,
    /*
     * The total rose from 1600 to 1900 when the hero gained the reference's jewel case.
     *
     * The case needs parts of Three.js the constellation never touched — physical materials, the
     * PMREM environment generator, area lights — and that took the Three chunk from about 640KB to
     * 988KB. It is a real cost and it is recorded here rather than absorbed quietly; what keeps it
     * honest is that none of it is in the first load. It arrives at idle, after the page has
     * painted, and only for people whose browser can draw it.
     */
    totalBudgetKb: 1900,
    // Three.js belongs to the constellation and the jewel case; the tag reader only to a scan.
    mustBeSplit: ['three', 'music-metadata'],
  },
  {
    name: 'hub-admin',
    distDir: join(repoRoot, 'docker-container', 'dist', 'web'),
    html: 'index.html',
    // Currently 534KB, all of it the first load: the admin GUI is one screen behind a login.
    entryBudgetKb: 560,
    totalBudgetKb: 580,
    mustBeSplit: [],
  },
];

/** The files `index.html` pulls in before the app can render: scripts, stylesheets and preloads. */
function entryAssets(distDir: string, htmlName: string): string[] {
  const html = readFileSync(join(distDir, htmlName), 'utf8');
  const hrefs = new Set<string>();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) hrefs.add(match[1]!);
  for (const match of html.matchAll(/<link[^>]+rel="(?:stylesheet|modulepreload|preload)"[^>]+href="([^"]+)"/g)) hrefs.add(match[1]!);
  for (const match of html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="(?:stylesheet|modulepreload|preload)"/g)) hrefs.add(match[1]!);
  return [...hrefs].filter((href) => href.endsWith('.js') || href.endsWith('.css')).map((href) => join(distDir, href.replace(/^\/+/, '').replace(/^\.\//, '')));
}

function kb(bytes: number): number {
  return Math.round(bytes / 1024);
}

function emittedBytes(distDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Source maps are never downloaded by a normal visitor, so they do not count.
      else if (/\.(js|css|html)$/.test(entry.name)) total += statSync(full).size;
    }
  };
  walk(distDir);
  return total;
}

describe.each(BUNDLES)('$name', (bundle) => {
  const built = existsSync(join(bundle.distDir, bundle.html));

  it('has been built (run `pnpm build` first — this gate measures real output, it does not estimate)', () => {
    expect(built, `${bundle.distDir} has no ${bundle.html}`).toBe(true);
  });

  it.runIf(built)('keeps the first load inside its budget', () => {
    const assets = entryAssets(bundle.distDir, bundle.html);
    expect(assets.length, 'index.html referenced no scripts or stylesheets').toBeGreaterThan(0);
    const total = assets.reduce((sum, path) => sum + statSync(path).size, 0);
    // The message carries the numbers, so a failure says what to do rather than only that it broke.
    expect(kb(total), `first load is ${kb(total)}KB against a ${bundle.entryBudgetKb}KB budget (${assets.map((a) => `${a.split('/').pop()} ${kb(statSync(a).size)}KB`).join(', ')})`).toBeLessThanOrEqual(bundle.entryBudgetKb);
  });

  it.runIf(built)('keeps everything it emits inside its budget', () => {
    const total = emittedBytes(bundle.distDir);
    expect(kb(total), `the build emits ${kb(total)}KB against a ${bundle.totalBudgetKb}KB budget`).toBeLessThanOrEqual(bundle.totalBudgetKb);
  });

  it.runIf(built && bundle.mustBeSplit.length > 0)('keeps the expensive dependencies out of the first load', () => {
    const entry = entryAssets(bundle.distDir, bundle.html)
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    for (const marker of bundle.mustBeSplit) {
      // A crude but effective check: these libraries all leave unmistakable strings behind.
      const signature = marker === 'three' ? /THREE\.WebGLRenderer|BufferGeometry/ : /music-metadata|ID3v2Parser/;
      expect(signature.test(entry), `${marker} is in the entry chunk; it must stay behind a dynamic import`).toBe(false);
    }
  });
});
