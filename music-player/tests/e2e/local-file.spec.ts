/**
 * The single-file build, opened the way a person opens it: from the filesystem.
 *
 * This suite has its own config (`playwright.local.config.ts`) because it must *not* have a web
 * server. Everything here would pass trivially over http; the whole point is the `file://` origin,
 * which Chromium treats as `null` and refuses almost every fetch from. Three separate bugs in this
 * build were invisible until it was actually opened that way:
 *
 * - the bundle was spliced into React's source, because `String.replace` expands `$&` in a
 *   replacement string and minified React contains `"$&/"`;
 * - the check meant to catch leftover file references stripped the `src` attribute it was looking
 *   for, so it passed while the page was still fetching a chunk;
 * - a classic script inlined into `<head>` ran before `#root` existed.
 *
 * None of them are visible in a served build. They are all visible in the first second here.
 *
 * Rewritten for the shell (DEC-019). The React build's "Running from a file" panel, which listed
 * the features a browser withholds from a local page, has no counterpart in the shell and its two
 * tests went with it; that is recorded as not done in the plan file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * The *committed* file at the repository root, not the build directory.
 *
 * That is the file someone downloads, so it is the file these tests open. `pnpm verify` and CI
 * separately assert it matches what the source currently produces, so testing the committed copy
 * cannot mean testing something stale.
 */
const HTML_PATH = fileURLToPath(new URL('../../../now-playing.html', import.meta.url));
const FILE_URL = `file://${HTML_PATH}`;

/** Console errors and anything the page tried to load from outside itself. */
function watch(page: Page): { errors: string[]; external: string[] } {
  const errors: string[] = [];
  const external: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('file://') && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
  });
  return { errors, external };
}

test.describe('the file itself', () => {
  test('is one file, with nothing beside it', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    // Strip the script and style bodies, keeping their opening tags, then look for anything the
    // page would have to fetch. The tags must survive the strip or this check finds nothing.
    const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>').replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');
    const references = [...new Set([...markup.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map((match) => match[1]!))];
    expect(references, 'the page must reference no file beside itself').toEqual([]);
  });

  test('carries no service worker or manifest, which cannot work from a file anyway', () => {
    const html = readFileSync(HTML_PATH, 'utf8');
    expect(html).not.toContain('rel="manifest"');
    expect(html).not.toMatch(/serviceWorker\s*\.\s*register/);
  });
});

test.describe('opened from the filesystem', () => {
  /** The shell, opened as a person opens it, with the bridge's store and library in place. */
  async function open(page: Page): Promise<void> {
    await page.goto(FILE_URL);
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
  }

  test('renders with no console errors and no request leaving the page, Statistics and its 3D views included', async ({ page }) => {
    const seen = watch(page);
    await open(page);
    await expect(page.locator('#libraryRows')).toBeVisible();
    await expect(page.locator('.player__title')).toBeVisible();
    // three.js is inside the file: the 3D views draw with no CDN and no chunk beside it.
    await page.click('#profile');
    await page.click('#pt-stats');
    await page.waitForSelector('#pp-stats[data-ready="true"]', { timeout: 20_000 });
    expect(await page.evaluate(() => Boolean((window as unknown as { THREE?: { OrbitControls?: unknown } }).THREE?.OrbitControls))).toBe(true);
    expect(seen.errors).toEqual([]);
    expect(seen.external, 'nothing may leave a local file').toEqual([]);
  });

  test('loads the retune worklet from inside itself', async ({ page }) => {
    await page.goto(FILE_URL);
    /*
     * A worklet module is fetched with CORS, which a `file://` page cannot do — but `data:` is on
     * Chromium's allowed-scheme list, so the compiled worklet travels inside the bundle. This is
     * the difference between retuning working and the app honestly reporting that it fell back to
     * changing playback speed, so it is worth asserting rather than assuming.
     */
    const result = await page.evaluate(async () => {
      const context = new AudioContext();
      try {
        const source = 'class P extends AudioWorkletProcessor{process(){return true}}registerProcessor("probe",P);';
        await context.audioWorklet.addModule(`data:text/javascript;base64,${btoa(source)}`);
        return 'ok';
      } catch (error) {
        return `FAIL ${(error as Error).message}`;
      } finally {
        await context.close();
      }
    });
    expect(result).toBe('ok');
  });

  test('indexes a real audio file picked from the disk, and remembers it', async ({ page }) => {
    /*
     * The headline claim of this build is "it plays the music already on your device". This
     * checks that it does the thing it is for — reads a real WAV off the disk through Sources ▸
     * Music, parses its tags with the bundled reader, and keeps the index in the browser.
     */
    const seen = watch(page);
    await open(page);
    await page.evaluate(() => { location.hash = '#settings/src'; });
    await expect(page.locator('#pp-src')).toBeVisible();

    const fixture = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/01 Quiet Arithmetic.wav', import.meta.url));
    const chooser = page.waitForEvent('filechooser');
    await page.click('#libAddFiles');
    await (await chooser).setFiles([fixture]);

    // The title comes from the file's own tags, read by the reader bundled into this page.
    await expect.poll(() => page.evaluate(() => window.LIBRARY!.map((s) => s.title)), { timeout: 20_000 }).toContain('Quiet Arithmetic');
    await expect(page.locator('#libRoots')).toContainText('1 track');
    expect(seen.errors).toEqual([]);
    expect(seen.external, 'reading a local file must not cause a request').toEqual([]);

    // And it is in the browser's store, so it is still there after a reload.
    await page.reload();
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    expect(await page.evaluate(() => window.LIBRARY!.map((s) => s.title))).toContain('Quiet Arithmetic');
  });
});
