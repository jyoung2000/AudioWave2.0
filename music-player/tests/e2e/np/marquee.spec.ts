/**
 * Marquee multi-select on the song list and the menu for several songs (NPD-030). Ported from
 * airwave-np tests/marquee.mjs; the rows are the eight seeded WAVs, widened to the whole library.
 */
import { expect, test } from '@playwright/test';
import { boot, resetToLibrary, seed, watchErrors } from './_shell';

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await boot(page);
  await seed(page);
  await resetToLibrary(page);
  await page.click('#mode [data-mode="group"]').catch(() => undefined); await page.waitForTimeout(200);
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('dragging draws a selection box, and the menu for several acts on all of them', async ({ page }) => {
  const titleBefore = (await page.textContent('.player__title'))!.trim();
  const box = async (n: number) => (await (await page.$(`#libraryRows tr:nth-child(${n}) .lib-col-album`))!.boundingBox())!;
  const a = await box(2), z = await box(5);
  await page.mouse.move(a.x + 10, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 20, { steps: 3 });
  expect(await page.isVisible('.marquee'), 'dragging draws a selection box').toBe(true);
  await page.mouse.move(z.x + 60, z.y + z.height / 2, { steps: 6 });
  await page.mouse.up(); await page.waitForTimeout(200);
  const sel = await page.$$eval('#libraryRows tr[aria-selected="true"]', (r) => r.map((x) => (x as HTMLElement).dataset['id']));
  expect(sel.length, 'every row the box touched is selected').toBe(4);
  expect(await page.$('.marquee'), 'and the box goes away on release').toBeNull();
  expect((await page.textContent('.player__title'))!.trim(), 'finishing a drag does not play a song').toBe(titleBefore);

  const m = await box(3);
  await page.mouse.click(m.x + 10, m.y + 5, { button: 'right' }); await page.waitForTimeout(200);
  expect((await page.isVisible('#ctx')) || (await page.$eval('.ctx', (x) => !(x as HTMLElement).hidden)), 'right-click on the selection opens the menu').toBe(true);
  const txt = await page.$eval('.ctx', (x) => x.textContent!);
  expect(/4 Songs Selected/.test(txt) && /Download 4 Songs/.test(txt) && /New Playlist from 4 Songs/.test(txt), 'which acts on all four').toBe(true);
  await page.click('.ctx [data-act="m-download"]'); await page.waitForTimeout(200);
  const saved = await page.$$eval('#libraryRows tr[aria-selected="true"] .lib-dl', (r) => r.filter((x) => x.getAttribute('aria-pressed') === 'true').length);
  expect(saved, 'Download marks all four for offline').toBe(4);
  expect((await page.$$('#libraryRows tr[aria-selected="true"]')).length, 'the selection survives the repaint').toBe(4);

  await page.mouse.click(m.x + 10, m.y + 5, { button: 'right' }); await page.waitForTimeout(200);
  await page.click('.ctx [data-act="m-new"]'); await page.waitForTimeout(300);
  await page.keyboard.type('Picked four'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  await page.mouse.click(m.x + 10, m.y + 5, { button: 'right' }); await page.waitForTimeout(200);
  expect(await page.$$eval('.ctx [data-act="m-add"]', (r) => r.some((x) => /Picked four/.test(x.textContent!) && x.getAttribute('aria-checked') === 'true')), 'a new playlist made from the set holds all four').toBe(true);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  const r5 = await box(5);
  await page.keyboard.down('Control'); await page.mouse.click(r5.x + 10, r5.y + 5); await page.keyboard.up('Control'); await page.waitForTimeout(150);
  expect((await page.$$('#libraryRows tr[aria-selected="true"]')).length, 'Ctrl-click takes one out of the set').toBe(3);
  expect((await page.textContent('.player__title'))!.trim(), 'without playing it').toBe(titleBefore);
  await page.focus('#libraryRows tr[tabindex="0"]'); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  expect((await page.$$('#libraryRows tr[aria-selected="true"]')).length, 'Escape clears the selection').toBeLessThanOrEqual(1);
  const r2 = await box(2), r6 = await box(6);
  await page.keyboard.down('Control'); await page.mouse.click(r2.x + 10, r2.y + 5); await page.keyboard.up('Control');
  await page.keyboard.down('Shift'); await page.mouse.click(r6.x + 10, r6.y + 5); await page.keyboard.up('Shift'); await page.waitForTimeout(150);
  expect((await page.$$('#libraryRows tr[aria-selected="true"]')).length, 'Shift-click selects the range').toBe(5);
  const r4 = await box(4);
  await page.mouse.click(r4.x + 10, r4.y + 5); await page.waitForTimeout(300);
  expect((await page.$$('#libraryRows tr[aria-selected="true"]')).length, 'a plain click selects one song again').toBe(1);
});
