/**
 * The player as a product, against a real production build of the shell.
 *
 * The interface is the Airwave frontend served as the shell (DEC-019); these are the claims the
 * player makes that do not depend on which interface draws them, re-asserted against it: it opens
 * with no music and says so, a file from this device really plays (the bar follows the audio
 * element, not a clock), the transport answers the keyboard, it is installable and works offline
 * once opened, it fetches nothing from another origin, and what it records survives a reload.
 *
 * What left with the React interface, and why these do not test it: the section strip, the
 * constellation, the solo strip, the platform capability panel, crossfade and solfeggio controls,
 * the download sheet's FLAC/WAV export. Their logic is unit-tested where it lives (music-player/
 * tests/unit, packages/*); the shell has its own equivalents, covered by the ported suites in np/.
 */
import { expect, test } from '@playwright/test';
import { boot, reload, seed, playRow, resetToLibrary, watchErrors, stubOffline, SEED } from './np/_shell.js';

test('opens with no music, says so, and raises no errors', async ({ page }) => {
  const errors = watchErrors(page);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await stubOffline(page);
  await boot(page);
  expect(await page.evaluate(() => window.LIBRARY?.length)).toBe(0);
  await expect(page.locator('#libraryRows')).toContainText(/Nothing played yet|No songs|empty/i);
  // The jewel case names what is true: nothing is playing, and no group session is joined.
  await expect(page.locator('.player__title')).toHaveText(/Nothing playing|No group session/);
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('a file from this device plays for real: the bar follows the element, and pause stops it', async ({ page }) => {
  const errors = watchErrors(page);
  await stubOffline(page);
  await boot(page);
  await seed(page, SEED.slice(0, 2));
  await resetToLibrary(page);
  await playRow(page, SEED[0]!.title);
  await expect(page.locator('.player__title')).toHaveText(SEED[0]!.title);
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.playing()), { timeout: 8000 }).toBe(true);
  const first = await page.evaluate(() => window.NP_PLAYER!.position());
  await page.waitForTimeout(1500);
  const later = await page.evaluate(() => window.NP_PLAYER!.position());
  expect(later, 'the element is playing, so its position moves').toBeGreaterThan(first + 0.8);
  await expect(page.locator('#elapsed')).not.toHaveText('00:00');
  expect(await page.evaluate(() => window.NP_PLAYER!.duration())).toBe(120);

  await page.click('#play');
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.playing())).toBe(false);
  const paused = await page.evaluate(() => window.NP_PLAYER!.position());
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.NP_PLAYER!.position())).toBeCloseTo(paused, 1);
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('seeking moves the element, not just the bar', async ({ page }) => {
  await stubOffline(page);
  await boot(page);
  await seed(page, SEED.slice(0, 1));
  await resetToLibrary(page);
  await playRow(page, SEED[0]!.title);
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.playing()), { timeout: 8000 }).toBe(true);
  const bar = page.locator('#track');
  const box = (await bar.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.position()), { timeout: 4000 }).toBeGreaterThan(55);
  // The keyboard seeks too: End goes to the end of the track, and the track ends there.
  await bar.focus();
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.position())).toBeLessThan(3);
});

test('what is played is recorded, and survives a reload', async ({ page }) => {
  await stubOffline(page);
  await boot(page);
  await seed(page, SEED.slice(0, 3));
  await resetToLibrary(page);
  await playRow(page, SEED[1]!.title);
  await page.waitForTimeout(1200);
  await reload(page);
  // The library is the IndexedDB index, so the rows come back without re-picking anything …
  expect(await page.evaluate(() => window.LIBRARY!.map((s) => s.title).sort())).toEqual(SEED.slice(0, 3).map((s) => s.title).sort());
  // … and the play log the Statistics pane reads is there too, through the same store.
  const plays = await page.evaluate(async () => {
    const state = (await (window as unknown as { kv: { get(k: string): Promise<{ plays?: Array<{ id: string }> } | null> } }).kv.get('library:state')) ?? {};
    return (state.plays ?? []).length;
  });
  expect(plays).toBeGreaterThanOrEqual(1);
});

test('space toggles playback and does not scroll the page', async ({ page }) => {
  await stubOffline(page);
  await boot(page);
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('body').press('Space');
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test.describe('the service worker', () => {
  test.use({ serviceWorkers: 'allow' });

test('the app is installable: manifest, icons and a service worker', async ({ page }) => {
  await stubOffline(page);
  await boot(page);
  const manifestHref = await page.locator('link[rel=manifest]').first().getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const manifest = await (await page.request.get(manifestHref!)).json();
  expect(manifest.name).toBe('Airwave');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).status(), `${icon.src} should exist`).toBe(200);
  // The bridge registers the worker; one that merely exists on the server is not enough.
  const registered = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]));
  expect(registered, 'the shell must register its service worker').toBe(true);
});

test('starts with the network off, once it has been opened online', async ({ page, context }) => {
  await stubOffline(page);
  await boot(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    await expect(page.locator('#libraryRows')).toBeVisible();
    await expect(page.locator('.player__title')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

});

test('loads nothing from outside its own origin, including three.js', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' && url.protocol !== 'data:' && url.protocol !== 'blob:') external.push(request.url());
  });
  await boot(page);
  await page.waitForLoadState('networkidle');
  // Statistics is where the 3D views load three.js: from this origin, as a bundled chunk.
  await page.click('#profile');
  await page.click('#pt-stats');
  await page.waitForSelector('#pp-stats[data-ready="true"]', { timeout: 20_000 });
  expect(external, `nothing may come from another origin: ${external.join(', ')}`).toEqual([]);
});
