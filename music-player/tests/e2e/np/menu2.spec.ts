/**
 * The song's contextual menu: its six commands in three groups, the ellipsis rule, download and
 * queue toggles, Go to Album / Artist, Change Artist…, and solo mode. Ported from airwave-np
 * tests/menu2.mjs; the rows are the eight seeded WAVs.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, reload, resetToLibrary, seed, watchErrors } from './_shell';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await boot(page);
  await seed(page);
  await resetToLibrary(page);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

const open = async (p: Page, n = 3) => { await p.click(`#libraryRows tr:nth-child(${n})`, { button: 'right', position: { x: 200, y: 8 } }); await p.waitForTimeout(220); };
const count = (p: Page) => p.evaluate(() => document.querySelectorAll('#libraryRows tr[data-id]').length);

test('six commands in three groups, and an ellipsis marks exactly the dialog commands', async ({ page }) => {
  await open(page);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#ctx > *')].map((e) => {
    if (e.classList.contains('ctx__sep')) return '—';
    const t = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join('');
    return t || e.textContent!.trim(); }));
  expect(labels.length === 9 && labels[2] === '—' && labels[6] === '—', 'six commands in three groups: ' + JSON.stringify(labels)).toBe(true);
  expect(labels.filter((l) => l.includes('…')).join('|'), 'ellipsis marks exactly the dialog commands').toBe('Change Artist…|New Playlist…');
});

test('download and group queue toggle, with a toast and a label that flips', async ({ page }) => {
  await open(page);
  await page.click('#ctx [data-act="download"]'); await page.waitForTimeout(250);
  expect(await page.textContent('#toast'), 'download toggles + toast').toBe('Saved offline');
  expect(await page.getAttribute('#libraryRows tr:nth-child(3) .lib-dl', 'aria-pressed'), 'row glyph agrees').toBe('true');
  await open(page);
  expect(await page.textContent('#ctx [data-act="download"]'), 'label flips to Remove Download').toBe('Remove Download');
  await page.keyboard.press('Escape');

  await open(page);
  await page.click('#ctx [data-act="queue"]'); await page.waitForTimeout(250);
  expect(await page.textContent('#toast'), 'queue adds with count').toContain('group queue — 1 queued');
  await open(page);
  expect(await page.textContent('#ctx [data-act="queue"]'), 'queue label flips').toBe('Remove from Group Queue');
  await page.keyboard.press('Escape');
});

test('Go to Album and Go to Artist narrow the list; clearing the scope restores it', async ({ page }) => {
  await open(page);
  const albumOf = await page.evaluate(() => document.querySelector('#libraryRows tr:nth-child(3) .lib-col-album')!.textContent);
  await page.click('#ctx [data-act="go-album"]'); await page.waitForTimeout(350);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#libraryRows tr')].map((r) => r.querySelector('.lib-col-album')?.textContent));
  expect(rows.length > 0 && rows.every((r) => r === albumOf), `go to album filters: ${rows.length} rows, all "${albumOf}"`).toBe(true);
  expect((await page.getAttribute('#libScope', 'hidden')) === null && (await page.textContent('#libScopeLabel')) === albumOf, 'scope bar shown').toBe(true);
  await resetToLibrary(page);
  // ported: eight seeded rows, where the original counted sixteen
  expect((await count(page)) === 8 && (await page.getAttribute('#libScopeClear', 'hidden')) !== null && (await page.textContent('#libScopeLabel')) === 'Library', 'clearing the scope restores the list').toBe(true);

  await open(page);
  await page.click('#ctx [data-act="go-artist"]'); await page.waitForTimeout(350);
  expect(await page.evaluate(() => new Set([...document.querySelectorAll('#libraryRows tr .lib-col-artist')].map((e) => e.textContent)).size === 1), 'go to artist filters').toBe(true);
  expect(await page.textContent('#libScopeKind'), 'scope kind says Artist').toBe('Artist');
});

test('Change Artist… opens a prefilled dialog, renames, and the focus follows the rename', async ({ page }) => {
  await open(page);
  await page.click('#ctx [data-act="go-artist"]'); await page.waitForTimeout(350);
  await open(page, 1);
  await page.click('#ctx [data-act="edit-artist"]'); await page.waitForTimeout(350);
  expect((await page.textContent('#sheetTitle')) === 'Change Artist' && (await page.textContent('#sheetCreate')) === 'Save', 'dialog retitled').toBe(true);
  expect((await page.inputValue('#sheetInput')).length, 'dialog prefilled').toBeGreaterThan(0);
  await page.fill('#sheetInput', 'Fennel Grove Trio'); await page.click('#sheetCreate'); await page.waitForTimeout(400);
  expect(await page.textContent('#toast'), 'artist renamed').toContain('Fennel Grove Trio');
  expect(await page.textContent('#libScopeLabel'), 'focus followed the rename').toBe('Fennel Grove Trio');
});

test('rename persists across reload', async ({ page }) => {
  // Fails until the shell's kv shim reads back what the bridge stores (window.kv.get unwraps
  // `r.value`; the bridge returns the JSON string), which is why the annotation is here and not a
  // softer assertion: the day it passes, this line has to go.
  await open(page, 1);
  await page.click('#ctx [data-act="edit-artist"]'); await page.waitForTimeout(350);
  await page.fill('#sheetInput', 'Fennel Grove Trio'); await page.click('#sheetCreate'); await page.waitForTimeout(400);
  await reload(page);
  await resetToLibrary(page);
  expect(await page.evaluate(() => [...document.querySelectorAll('#libraryRows .lib-col-artist')].some((e) => e.textContent === 'Fennel Grove Trio')), 'rename persists across reload').toBe(true);
});

test('solo mode greys the queue command', async ({ page }) => {
  await page.click('.segmented__item[data-mode="solo"]'); await page.waitForTimeout(400);
  await open(page);
  expect(await page.evaluate(() => (document.querySelector('#ctx [data-act="queue"]') as HTMLButtonElement).disabled), 'queue disabled in solo mode').toBe(true);
  await page.keyboard.press('Escape');
});
