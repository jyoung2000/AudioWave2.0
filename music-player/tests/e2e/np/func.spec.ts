/**
 * A grab-bag of product properties: the avatar gradient, the transport's ARIA, the 24px optical
 * offset, sortable headers, the search popover (stubbed iTunes, escaping, add to library), the
 * toolbar views and the native dialog. Ported from airwave-np tests/func.mjs.
 *
 * The original's group album was a live broadcast, so its "while live" assertions read the
 * transport as refusing seeks. The shell's group session is not live (there is no invented
 * broadcast behind it), so those read the transport at rest instead: a slider, enabled keys.
 */
import { expect, test } from '@playwright/test';
import { boot, playRow, resetToLibrary, seed, stubOffline, watchErrors } from './_shell';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  // iTunes in its own shape, for songs only: with no hub or companion the browser asks it itself (DEC-039).
  await page.route('**/itunes.apple.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(new URL(r.request().url()).searchParams.get('entity') !== 'song' ? { results: [] } : {
    results: [{ wrapperType: 'track', kind: 'song', trackId: 71, trackName: 'Harbour Lights Live', artistName: 'Cassette Bloom', collectionName: 'Pier 9', trackViewUrl: 'https://music.apple.com/us/album/pier-9/70?i=71', artworkUrl100: null, previewUrl: 'about:blank', trackTimeMillis: 251000 },
      { wrapperType: 'track', kind: 'song', trackId: 72, trackName: "O'Malley's <b>Reel</b>", artistName: 'Test & Co', collectionName: 'X', trackViewUrl: 'https://music.apple.com/us/album/x/73?i=72', artworkUrl100: null, previewUrl: null, trackTimeMillis: 120000 }] }) }));
  await stubOffline(page);
  await boot(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('avatar gradient not black; the transport at rest is a slider with every key reachable', async ({ page }) => {
  const stop = await page.evaluate(() => getComputedStyle(document.querySelector('#avatarFill stop')!).stopColor);
  expect(stop, 'avatar gradient not black').not.toBe('rgb(0, 0, 0)');
  // ported: no broadcast at boot, so the track is a slider and no key is refused
  const t = await page.evaluate(() => { const e = document.getElementById('track')!; return { role: e.getAttribute('role'), min: e.getAttribute('aria-valuemin'), max: e.getAttribute('aria-valuemax') }; });
  expect(t.role === 'slider' && t.min !== null && t.max !== null, '#track is a slider when nothing is live: ' + JSON.stringify(t)).toBe(true);
  const tr = await page.evaluate(() => [...document.querySelectorAll('.transport__key')].map((k) => ({ id: k.id, disabled: (k as HTMLButtonElement).disabled, ariaDis: k.getAttribute('aria-disabled') })));
  expect(tr.every((x) => !x.disabled && x.ariaDis === 'false'), 'transport keys are enabled with nothing live').toBe(true);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])')].filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.id || e.className).slice(0, 14));
  expect(tabs.includes('play') && tabs.includes('prev'), 'tab order reaches transport: ' + tabs.slice(0, 10).join(' > ')).toBe(true);
  expect(await page.getAttribute('#live', 'hidden'), 'no LIVE marker with no broadcast').not.toBeNull();
});

test('24px optical offset preserved; sort headers are buttons and sorting works; page has h1', async ({ page }) => {
  const al = await page.evaluate(() => { const c = (s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return (r.left + r.right) / 2; }; return { keys: c('.transport__keys'), track: c('.player__track') }; });
  expect(Math.abs((al.track - al.keys) - 24), `24px optical offset preserved: delta ${(al.track - al.keys).toFixed(1)}px`).toBeLessThan(1.5);
  const th = await page.evaluate(() => document.querySelectorAll('thead th[data-sort] button').length);
  expect(th, 'sort headers are buttons').toBe(5);
  await page.click('thead th[data-sort="artist"] button'); await page.waitForTimeout(200);
  expect(await page.getAttribute('thead th[data-sort="artist"]', 'aria-sort'), 'sorting still works').toBe('ascending');
  expect(await page.evaluate(() => !!document.querySelector('h1')), 'page has h1').toBe(true);
});

test('search: add to library, escaping, a stale query, and focus loss closes the popover', async ({ page }) => {
  await seed(page);
  await resetToLibrary(page);
  await page.fill('#q', 'harbour'); await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row', { timeout: 10000 });
  const before = await page.evaluate(() => document.querySelectorAll('#libraryRows tr[data-id]').length);
  await page.click('.srch__row[data-i="0"] .srch__add'); await page.waitForTimeout(400);
  const after = await page.evaluate(() => document.querySelectorAll('#libraryRows tr[data-id]').length);
  expect(after, `add-to-library works: ${before} -> ${after}`).toBe(before + 1);
  expect(await page.textContent('.srch__row[data-i="0"] .srch__add'), 'add shows check after').toContain('✓');
  const escChk = await page.evaluate(() => ({ n: document.querySelectorAll('.srch__row').length, raw: document.getElementById('srchBody')!.innerHTML.indexOf('<b>Reel</b>'), txt: (document.querySelectorAll('.srch__title')[1] as HTMLElement | undefined)?.textContent ?? '' }));
  expect(escChk.n === 2 && escChk.raw === -1 && /<b>Reel<\/b>/.test(escChk.txt), 'HTML in a title is escaped, not parsed: ' + JSON.stringify(escChk)).toBe(true);

  await page.fill('#q', 'something else entirely'); await page.waitForTimeout(300);
  expect(((await page.getAttribute('#srch', 'class')) || '').includes('is-stale') && (await page.textContent('#srchCount'))!.includes('Press'), 'stale query marked').toBe(true);

  await page.press('#q', 'Escape'); await page.fill('#q', 'harbour'); await page.press('#q', 'Enter');
  await page.waitForSelector('.srch__row'); await page.evaluate(() => document.getElementById('profile')!.focus()); await page.waitForTimeout(250);
  expect(await page.getAttribute('#srch', 'hidden'), 'popover closes on focus loss').not.toBeNull();
});

test('toolbar filters the library and returns to Music on Now Playing', async ({ page }) => {
  await seed(page);
  await resetToLibrary(page);
  await playRow(page, 'Gantry');
  await page.click('.tb__btn[data-view="movies"]'); await page.waitForTimeout(300);
  const empty = await page.textContent('#libraryRows');
  expect(empty, 'toolbar filters library').toContain('No Movies yet');
  await page.click('.tb__btn[data-view="music"]'); await page.waitForTimeout(300);
  expect((await page.evaluate(() => document.querySelectorAll('#libraryRows tr[data-id]').length)) > 0 && (await page.textContent('#libScopeLabel')) === 'Now Playing', 'toolbar returns to music, on Now Playing').toBe(true);
});

test('the sheet is a native dialog that opens modal', async ({ page }) => {
  const dlg = await page.evaluate(() => { const d = document.getElementById('sheet') as HTMLDialogElement; return { tag: d.tagName, hasShowModal: typeof d.showModal === 'function' }; });
  expect(dlg.tag === 'DIALOG' && dlg.hasShowModal, 'sheet is a native dialog: ' + JSON.stringify(dlg)).toBe(true);
  await page.evaluate(() => (document.getElementById('sheet') as HTMLDialogElement).showModal());
  await page.waitForTimeout(200);
  const trapped = await page.evaluate(() => { const d = document.getElementById('sheet') as HTMLDialogElement; return { open: d.open, topLayer: d.matches(':modal') }; });
  expect(trapped.open && trapped.topLayer, 'dialog opens modal (browser trap + inert): ' + JSON.stringify(trapped)).toBe(true);
  await page.evaluate(() => (document.getElementById('sheet') as HTMLDialogElement).close());
});
