/**
 * The contextual menu is OS X 10.6 on a desktop and an iOS action sheet on touch, opaque in dark
 * too. Ported from airwave-np tests/menuverify.mjs; playlists are made through the menu itself
 * rather than written into kv.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, newPlaylistWith, resetToLibrary, seed, watchErrors } from './_shell';

test.describe('desktop: OS X menu', () => {
  let errors: string[];
  test.beforeEach(async ({ page }) => {
    errors = watchErrors(page);
    await boot(page);
    await seed(page);
    await resetToLibrary(page);
    // row 3 of the title-sorted seed is Ember Line; it goes into the one playlist
    await newPlaylistWith(page, 'Ember Line', 'Late Night');
  });
  test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

  test('era metrics, keyboard nav intact, escape closes, menu action still fires', async ({ page }) => {
    await page.click('#libraryRows tr:nth-child(3)', { button: 'right', position: { x: 200, y: 8 } });
    await page.waitForTimeout(250);
    expect(await page.getAttribute('#ctx', 'hidden'), 'menu opens on right-click').toBeNull();
    const m = await page.evaluate(() => { const c = getComputedStyle, x = document.getElementById('ctx')!, i = x.querySelector('.ctx__item')!;
      return { r: c(x).borderRadius, pad: c(x).padding, bg: c(x).backgroundColor, blur: c(x).backdropFilter, ir: c(i).borderRadius, ih: i.getBoundingClientRect().height, fs: c(i).fontSize }; });
    expect(m.r === '5px' && m.ir === '0px' && m.ih === 20 && m.fs === '13px' && m.blur === 'none' && m.bg === 'rgb(255, 255, 255)', 'era metrics: ' + JSON.stringify(m)).toBe(true);
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
    expect(await page.evaluate(() => document.activeElement!.classList.contains('ctx__item')), 'keyboard nav intact').toBe(true);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    expect(await page.getAttribute('#ctx', 'hidden'), 'escape closes').not.toBeNull();
    await page.click('#libraryRows tr:nth-child(3)', { button: 'right', position: { x: 200, y: 8 } });
    await page.hover('.ctx__item--parent'); await page.waitForTimeout(300);
    await page.click('.ctx__sub .ctx__item[data-act="toggle"]'); await page.waitForTimeout(300);
    expect(await page.textContent('#toast'), 'menu action still fires').toContain('Removed from');
  });
});

test.describe('touch: iOS action sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  let errors: string[];
  test.beforeEach(async ({ page }) => {
    errors = watchErrors(page);
    await boot(page);
    await seed(page);
  });
  test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

  const longPress = async (page: Page, n: number) => {
    const bb = (await (await page.$(`#libraryRows tr:nth-child(${n})`))!.boundingBox())!;
    await page.mouse.move(bb.x + 120, bb.y + bb.height / 2);
    await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
    await page.waitForTimeout(300);
  };

  test('long press raises action sheet, listing all commands + playlists + cancel, and its action fires', async ({ page }) => {
    // the list is on Now Playing; the Artists drill gets to rows without a right-click
    await page.click('#libMenuBtn'); await page.waitForTimeout(200);
    await page.click('#ipodMenu .ipod__item[data-i="3"]'); await page.waitForTimeout(200);
    await page.click('#ipodMenu .ipod__item[data-i="0"]'); await page.waitForTimeout(300);
    // one playlist, made from the sheet on row 2, so row 3 is not yet in it
    await longPress(page, 2);
    await page.click('#actSheet [data-act="new-add"]');
    await page.waitForSelector('#sheet[open]', { timeout: 3000 });
    await page.fill('#sheetInput', 'Late Night'); await page.click('#sheetCreate'); await page.waitForTimeout(400);
    await longPress(page, 3);
    expect(await page.getAttribute('#actSheet', 'hidden'), 'long press raises action sheet').toBeNull();
    expect(await page.evaluate(() => document.querySelectorAll('#actSheet .sheet-act__btn').length), 'sheet lists all commands + playlists + cancel').toBe(8);
    await page.click('#actSheet [data-act="toggle"]'); await page.waitForTimeout(300);
    expect(await page.textContent('#toast'), 'sheet action fires').toContain('Added to');
  });
});

test.describe('dark', () => {
  test.use({ colorScheme: 'dark', deviceScaleFactor: 2 });
  test('dark menu opaque', async ({ page }) => {
    await boot(page);
    await seed(page);
    await resetToLibrary(page);
    await page.click('#libraryRows tr:nth-child(3)', { button: 'right', position: { x: 200, y: 8 } });
    await page.hover('.ctx__item--parent'); await page.waitForTimeout(350);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('ctx')!).backgroundColor), 'dark menu opaque').toBe('rgb(43, 46, 52)');
  });
});
