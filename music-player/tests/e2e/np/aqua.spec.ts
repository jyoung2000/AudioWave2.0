/**
 * Settings' controls: Snow Leopard push buttons, 10.4 Aqua pop-ups and checkboxes — native elements
 * wearing the drawings AquaArt makes from sampled profiles (NPD-021, NP-PREF-006). Ported from
 * airwave-np tests/aqua.mjs. The original asserted that every drawing is published as a custom
 * property, that buttons, pop-ups and checkboxes wear them (disabled, dark and 30px touch variants
 * included), that a pop-up is as wide as its choices and that the controls still work. None of it
 * depended on demo data; the three browser pages become three tests.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, watchErrors } from './_shell';

const src = (p: Page, sel: string) => p.$eval(sel, (e) => getComputedStyle(e).borderImageSource);
const svg = (s: string) => /^url\("data:image\/svg\+xml,/.test(s);
const cssVar = (p: Page, n: string) => p.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), n);

let errors: string[];
test.beforeEach(async ({ page }) => { errors = watchErrors(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test.describe('desktop', () => {
  test.use({ viewport: { width: 1100, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
  test('buttons, pop-ups and checkboxes wear the Aqua drawings and still work', async ({ page }) => {
    await boot(page, '#settings/src');
    const missing = await page.evaluate(() => ['--aq-btn-22', '--aq-def-22', '--aq-pop-22', '--aq-cb-14-on', '--aq-btn-30', '--aq-pop-30', '--aq-cb-18']
      .filter((n) => !getComputedStyle(document.documentElement).getPropertyValue(n).includes('data:image/svg+xml')));
    expect(missing, 'AquaArt publishes every drawing as a custom property').toEqual([]);
    expect(svg(await src(page, '#hubTest')), 'a push button wears the matte metal pill').toBe(true);
    const box = await page.$eval('#hubTest', (e) => ({ h: e.getBoundingClientRect().height, r: getComputedStyle(e).borderRadius }));
    expect(box, 'at the 22px Aqua height, with a pill-shaped focus ring').toEqual({ h: 22, r: '11px' });
    expect(await src(page, '#prefsRevert'), 'a disabled button wears the washed-out drawing').toBe(await cssVar(page, '--aq-btn-22-off'));

    await boot(page, '#settings/player');
    expect(await page.$eval('#cfgTheme', (e) => e.tagName === 'SELECT' && getComputedStyle(e).appearance === 'none'), 'a pop-up is still a native select, drawn as Aqua').toBe(true);
    expect(svg(await src(page, '#cfgTheme')), 'with the white body and the blue arrow segment').toBe(true);
    const w = await page.$eval('#cfgTab', (e) => e.getBoundingClientRect().width);
    expect(w >= 200 && w < 400, 'and it is as wide as its choices, not the pane: ' + Math.round(w)).toBe(true);
    await page.selectOption('#cfgTab', { index: 1 });
    expect(await page.$eval('#cfgTab', (e) => (e as HTMLSelectElement).selectedIndex), 'choosing from it still works').toBe(1);
    const off = await src(page, '#cfgMotion'), on = await src(page, '#cfgStage');
    expect(svg(off) && svg(on) && off !== on, 'checkboxes wear grey gel off and blue gel on').toBe(true);
    await page.click('label:has(#cfgMotion)');
    expect(await page.$eval('#cfgMotion', (e) => (e as HTMLInputElement).checked), 'and clicking the label still ticks it').toBe(true);
    await page.mouse.move(5, 5); await page.waitForTimeout(150);
    expect(await src(page, '#cfgMotion'), 'which swaps in the blue drawing').toBe(on);
  });
});

test.describe('dark', () => {
  test.use({ viewport: { width: 1100, height: 900 }, colorScheme: 'dark', contextOptions: { reducedMotion: 'reduce' } });
  test('the gel keeps its daylight ink', async ({ page }) => {
    await boot(page, '#settings/src');
    expect(await page.$eval('#hubTest', (e) => getComputedStyle(e).color), 'in dark, button labels stay black on the light metal').toBe('rgb(0, 0, 0)');
  });
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the 30px drawings on a phone', async ({ page }) => {
    await boot(page, '#settings/player');
    const h = await page.$eval('#cfgTheme', (e) => e.getBoundingClientRect().height);
    expect(h, 'on a phone the pop-up grows to 30px').toBe(30);
    expect(await src(page, '#cfgTheme'), 'and uses the 30px drawing').toBe(await cssVar(page, '--aq-pop-30'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'and nothing overflows').toBe(false);
  });
});
