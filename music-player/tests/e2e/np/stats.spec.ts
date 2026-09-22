/**
 * Statistics as the Discover statistics page (NPD-023): the sections, the source line, the 3D views
 * and their tables, import and export, the dark theme, and a phone. Ported from airwave-np
 * tests/stats.mjs.
 *
 * The original opened on a generated demo year and asserted `#sbSrc` began “Demo year ·”, that more
 * than three genres were named and at least five top songs listed. The shell generates nothing, so
 * those assertions are rewritten against real history: before any play the page says nothing has
 * been recorded; then eight generated WAVs are indexed, two rows are played through the list, the
 * plays are read back from `library:state`, and the page is asserted to name this player’s history
 * and to count exactly those plays. Export and import round-trip the real events. The three.js-blocked
 * case now blocks the bundled chunk (the shell never fetches three from a CDN).
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, playRow, resetToLibrary, seed, statsReady, watchErrors } from './_shell';
import { readFileSync } from 'node:fs';

type KvState = { plays?: Array<{ id: string; at: number }> } | null;
const plays = (page: Page) => page.evaluate(async () => {
  const s = (await (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv.get('library:state')) as KvState;
  return s && s.plays ? s.plays.length : 0;
});

/** Index the seed, play two rows, and wait until both plays are in the stored log. */
async function listen(page: Page): Promise<void> {
  await seed(page);
  await page.click('#mode [data-mode="solo"]'); await page.waitForTimeout(300);
  await resetToLibrary(page);
  await playRow(page, 'Harbour Morning');
  await page.waitForTimeout(600);
  await playRow(page, 'Paper Harbour');
  await expect.poll(() => plays(page), { message: 'both plays are logged in library:state' }).toBe(2);
}

let errors: string[];
test.beforeEach(async ({ page }) => { errors = watchErrors(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'reduce' }, acceptDownloads: true });

  test('before any play: nothing recorded, and no generated source on offer', async ({ page }) => {
    await boot(page, '#settings/stats'); await statsReady(page);
    // ported: the #srcSel options were demo/browser/import; the shell offers only real sources
    expect(await page.$$eval('#srcSel option', (o) => o.map((x) => (x as HTMLOptionElement).value)), 'the source select offers only this player and an imported file').toEqual(['browser', 'import']);
    expect(await page.inputValue('#srcSel'), 'and shows this player’s history').toBe('browser');
    // ported: was “#sbSrc starts with 'Demo year ·'”
    expect(await page.textContent('#sbSrc'), 'the source line names this player’s history, with no events').toBe('This player’s history · 0 events');
    await expect(page.locator('#dataNote'), 'the data note says nothing has been recorded').toContainText('Nothing has been recorded yet');
    expect(await page.$$('#pp-stats .v3d canvas'), 'three 3D views: the skyline, the constellation and the sound space').toHaveLength(3);
    expect(await page.$$('#pp-stats .stjump__tab'), 'a strip of six section icons at the top').toHaveLength(6);
    expect(await page.$$('#pp-stats .stat__tile'), 'eight tiles in the overview').toHaveLength(8);
  });

  test('after real plays: the page counts them, and export and import round-trip them', async ({ page }) => {
    await boot(page);
    await listen(page);
    await boot(page, '#settings/stats'); await statsReady(page);
    // ported: was “#sbSrc starts with 'Demo year ·'”; now the real history and its real count
    expect(await page.textContent('#sbSrc'), 'the source line names this player’s history and counts the two plays').toBe('This player’s history · 2 events');
    expect(await page.$eval('#srcSel option[value="browser"]', (o) => o.textContent), 'the source select counts them too').toBe('This player’s history (2)');
    await expect(page.locator('#dataNote'), 'the data note describes what was recorded').toContainText('This is what this player has recorded: 2 plays');
    expect(await page.$$('#pp-stats .v3d canvas'), 'three 3D views').toHaveLength(3);
    expect(await page.$$('#pp-stats .stat__tile'), 'eight tiles in the overview').toHaveLength(8);
    // ported: was “more than three genres”; the seed carries no genre, so every row still names its genre
    const genreRows = await page.$$eval('#gList .grow', (n) => n.map((r) => r.querySelector('.grow__t')?.textContent ?? ''));
    expect(genreRows.length >= 1 && genreRows.every(Boolean), 'every genre colour carries its name beside it: ' + genreRows.join(', ')).toBe(true);
    await page.click('#s-when .numbers > summary');
    expect((await page.$$('#skyTable tbody tr, #skyTable tr')).length, 'the skyline can be read as a table').toBeGreaterThanOrEqual(7);
    await page.click('#tKind [data-tkind="songs"]'); await page.waitForTimeout(250);
    // ported: was “at least five top songs”; now exactly the two songs that were played
    const top = await page.$$eval('#topTable tbody tr', (n) => n.map((r) => r.textContent ?? ''));
    expect(top.length, 'top songs lists the two songs played').toBe(2);
    expect(top.some((t) => t.includes('Harbour Morning')) && top.some((t) => t.includes('Paper Harbour')), 'by their titles').toBe(true);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bJson')]);
    const rows = JSON.parse(readFileSync((await dl.path())!, 'utf8')) as Array<{ meta?: unknown; name?: string }>;
    // ported: was “rows.length > 0”; now exactly the real plays
    expect(Array.isArray(rows) && rows.length === 2 && !!rows[0]!.meta, 'export writes the two events it shows, in the player’s event shape').toBe(true);
    await page.setInputFiles('#fImport', { name: 'mine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(rows)) });
    await page.waitForTimeout(500);
    // ported: was “Imported 40 events” from the demo year
    await expect(page.locator('#ioMsg'), 'and an exported file imports back').toContainText('Imported 2 events');
    expect(await page.inputValue('#srcSel'), 'as the imported source').toBe('import');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark')); await page.waitForTimeout(500);
    const px = await page.evaluate(() => {
      const cv = document.querySelector('#v-sky canvas') as HTMLCanvasElement;
      const gl = (cv.getContext('webgl2') || cv.getContext('webgl')) as WebGLRenderingContext;
      const d = new Uint8Array(4);
      const v = (window as unknown as { AW: { views: { sky: { view: { renderer: { render(s: unknown, c: unknown): void }; scene: unknown; camera: unknown } } } } }).AW.views.sky.view;
      v.renderer.render(v.scene, v.camera);
      gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, d); return [...d];
    });
    expect(px[0]! < 80 && px[1]! < 80 && px[2]! < 90, 'in dark, the 3D wells turn dark too: ' + px).toBe(true);
  });

  test('reopening Statistics with nothing recorded', async ({ page }) => {
    // Not in the original (it always had the demo year): the refresh path with an empty history.
    // It used to build new AW.Dataset(null) and throw; make-shell.py now reads an empty history as
    // an empty year on refresh too.
    await boot(page, '#settings/stats'); await statsReady(page);
    await page.click('#prefsBack'); await page.waitForTimeout(350);
    await boot(page, '#settings/stats');
    await page.click('#pt-player'); await page.waitForTimeout(250);
    await page.click('#pt-stats'); await page.waitForTimeout(600);
    expect(await page.textContent('#sbSrc'), 'still this player’s history, with no events').toBe('This player’s history · 0 events');
  });
});

test.describe('three.js blocked', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test('the wells say so, the tables stay', async ({ page }) => {
    // ported: the original aborted cdn.jsdelivr.net; the shell bundles three as its own chunk
    await page.route(/\/assets\/three-[^/]*\.js/, (r) => r.abort());
    await boot(page, '#settings/stats'); await statsReady(page);
    const none = await page.$$eval('#pp-stats .v3d__none', (n) => n.map((x) => x.textContent ?? ''));
    expect(none.length === 3 && none.every((t) => t.includes('couldn’t load')), 'without three.js each 3D well says it could not load: ' + JSON.stringify(none)).toBe(true);
    expect(await page.$$('#pp-stats .stat__tile'), 'and the rest of the page is unaffected').toHaveLength(8);
    errors.length = 0; // the aborted dynamic import is reported by the bridge, not a page fault under test
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('nothing scrolls sideways', async ({ page }) => {
    await boot(page, '#settings/stats'); await statsReady(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'on a phone nothing scrolls sideways').toBe(false);
  });
});
