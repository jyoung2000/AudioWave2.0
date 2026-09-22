/**
 * Settings ▸ Equalizer ▸ Default volume (NPD-026): one level every source starts at, either where
 * you left it or a fixed default. Ported from airwave-np tests/volume.mjs. The original asserted the
 * pane's defaults (“where you left it”, 72%), that Set Volume Now moves the bar and the video element
 * together, and that each mode decides the level a reload opens at. Nothing here depended on demo
 * data, so the assertions are unchanged; only the bridge wait on each load is new.
 */
import { expect, test } from '@playwright/test';
import { boot, reload, watchErrors } from './_shell';

type W = Window & { outputVolume: number; setOutputVolume(n: number): void };

let errors: string[];
test.beforeEach(async ({ page }) => {
  errors = watchErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
});
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('the default volume: Set Volume Now, then each start mode across a reload', async ({ page }) => {
  await boot(page, '#settings/eq');
  expect(await page.isVisible('#volGroup'), 'the Equalizer pane has a default volume').toBe(true);
  expect(await page.inputValue('#volMode'), 'it starts as “where you left it”').toBe('last');
  expect(await page.inputValue('#volDefault'), 'at 72%').toBe('72');
  await page.$eval('#volDefault', (e) => {
    (e as HTMLInputElement).value = '35';
    e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change'));
  });
  expect(await page.textContent('#volDefaultVal'), 'the slider shows its level').toBe('35%');
  await page.click('#volApply'); await page.waitForTimeout(200);
  expect(await page.evaluate(() => Math.round((window as unknown as W).outputVolume * 100)), 'Set Volume Now moves the output volume').toBe(35);
  expect(await page.getAttribute('#volume', 'aria-valuenow'), 'and the bar’s volume').toBe('35');
  expect(await page.evaluate(() => Math.round((document.getElementById('vp_video') as HTMLVideoElement).volume * 100)), 'and TV and films follow the same volume').toBe(35);

  await page.selectOption('#volMode', 'fixed'); await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as W).setOutputVolume(90)); await page.waitForTimeout(600);
  await reload(page);
  expect(await page.getAttribute('#volume', 'aria-valuenow'), 'with “start at the default”, the player opens at 35% whatever the bar was left at').toBe('35');

  await boot(page, '#settings/eq');
  await page.selectOption('#volMode', 'last'); await page.waitForTimeout(200);
  await page.evaluate(() => (window as unknown as W).setOutputVolume(60)); await page.waitForTimeout(600);
  await reload(page);
  expect(await page.getAttribute('#volume', 'aria-valuenow'), 'with “where I left it”, it opens where the bar was left').toBe('60');
});
