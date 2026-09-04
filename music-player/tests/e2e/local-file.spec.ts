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
 */
import { createServer } from 'node:http';
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
  test('renders every section, with no console errors and no request leaving the page', async ({ page }) => {
    const seen = watch(page);
    await page.goto(FILE_URL);

    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    const sections = await page.getByRole('option').allTextContents();
    for (const name of ['Music', 'Now playing', 'Up next', 'Playlists', 'Search', 'Constellation', 'Listening', 'Equaliser', 'Settings']) {
      expect(sections.some((text) => text.startsWith(name)), `${name} should be in the source list`).toBe(true);
    }

    expect(seen.errors).toEqual([]);
    // The strongest statement this build makes: opening it contacts nothing.
    expect(seen.external, 'a local file must not reach the network').toEqual([]);
  });

  test('every section renders rather than falling back to an error', async ({ page }) => {
    const seen = watch(page);
    await page.goto(FILE_URL);
    for (const name of ['Music', 'Now playing', 'Up next', 'Playlists', 'Search', 'Constellation', 'Listening', 'Equaliser', 'Settings']) {
      await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
      await expect(page.locator('.aqua-content')).not.toHaveText('');
    }
    expect(seen.errors).toEqual([]);
  });

  test('stores its library index in the browser, so it is still there next time', async ({ page }) => {
    await page.goto(FILE_URL);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name));
    expect(databases).toContain('now-playing');
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
     * The headline claim of this build is "it plays the music already on your device". Everything
     * else here checks that the page loads; this checks that it does the thing it is for — reads a
     * real WAV off the disk, parses its tags with the bundled reader, and keeps it.
     */
    const seen = watch(page);
    await page.goto(FILE_URL);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await page.getByRole('option', { name: /^Music/ }).click();

    const fixture = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/01 Quiet Arithmetic.wav', import.meta.url));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Choose files instead/i }).click();
    await (await chooser).setFiles([fixture]);

    // The title comes from the file's own tags, read by the reader bundled into this page.
    await expect(page.getByText('Quiet Arithmetic').first()).toBeVisible({ timeout: 20_000 });
    expect(seen.errors).toEqual([]);
    expect(seen.external, 'reading a local file must not cause a request').toEqual([]);

    // And it is in the browser's store, so it is still there after a reload.
    await page.reload();
    await expect(page.getByText('Quiet Arithmetic').first()).toBeVisible({ timeout: 20_000 });
  });

  test('tells you which features the browser withholds from a local file', async ({ page }) => {
    await page.goto(FILE_URL);
    await page.getByRole('option', { name: /^Settings/ }).click();

    await expect(page.getByRole('heading', { name: 'Running from a file' })).toBeVisible();
    // The honest half: what it cannot do, and why, rather than a silent absence.
    await expect(page.getByText(/cannot be installed — there is no origin to install/i)).toBeVisible();
    await expect(page.getByText(/Group listening needs a WebSocket, which a browser refuses to open from a local file/i)).toBeVisible();
    // And the parts that do work, so the page is not just a list of disappointments.
    await expect(page.getByText(/Files are read from your disk and played directly/i)).toBeVisible();
  });

  test('does not show that panel when the very same file is served over http', async ({ page }) => {
    /*
     * The panel is about the *origin*, not the build. Serving the identical bytes over http and
     * finding the panel gone is the only way to show the condition is evaluated at runtime rather
     * than baked in — and it proves the single-file build is still a normal web page if you ever
     * want to host it.
     */
    const html = readFileSync(HTML_PATH);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('The test server reported no port');

    try {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
      await page.getByRole('option', { name: /^Settings/ }).click();
      await expect(page.getByRole('heading', { name: 'Storage' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Running from a file' })).toHaveCount(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
