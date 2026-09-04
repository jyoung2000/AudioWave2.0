/**
 * End-to-end flows for the player, against a real production build.
 *
 * These check what a person actually experiences: the app loads with no music and says what to do,
 * the transport row carries Star / Add to playlist / Share, the equaliser explains what it is doing,
 * and every screen is reachable by keyboard. They deliberately do not stub the app's own modules —
 * a test that passes against a mock of the thing under test proves nothing.
 */
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test('loads with no console errors and an honest empty state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  await expect(page.getByText('No music yet')).toBeVisible();
  // The empty state must say what adding a folder does, because people are right to be wary.
  await expect(page.getByText(/nothing is copied, uploaded or moved/i)).toBeVisible();
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the transport row carries star, add-to-playlist and share beside the play controls', async ({ page }) => {
  const transport = page.getByRole('group', { name: 'Playback controls' });
  await expect(transport).toBeVisible();
  await expect(transport.getByRole('button', { name: /favourites/i })).toBeVisible();
  await expect(transport.getByRole('button', { name: /Add to a playlist/i })).toBeVisible();
  await expect(transport.getByRole('button', { name: /Share this song/i })).toBeVisible();
  await expect(transport.getByRole('button', { name: /^Shuffle$/i })).toBeVisible();
});

test('the status bar carries the listening mode, and says why shared is unavailable', async ({ page }) => {
  /*
   * The mode switch is the one control on this page that is *usually* half-unavailable: shared
   * listening needs a hub, and most people opening the player have not paired one. The rule is that
   * it stays visible and reports the reason rather than vanishing or doing nothing, so this checks
   * the unavailable half as carefully as the available one.
   */
  const modes = page.getByRole('radiogroup', { name: 'Listening mode' });
  await expect(modes).toBeVisible();
  await expect(modes.getByRole('radio', { name: 'Solo listening' })).toHaveAttribute('aria-checked', 'true');

  const shared = modes.getByRole('radio', { name: /Shared listening/ });
  await expect(shared).toHaveAttribute('aria-disabled', 'true');
  await expect(shared).toHaveAccessibleName(/needs a paired hub/i);

  /*
   * Reaching for it explains rather than doing nothing. Driven from the keyboard because that is
   * the path a person actually takes through a radio group — and because `aria-disabled` (which is
   * the truthful state: you cannot select it) means an automated pointer click is refused, exactly
   * as it should be.
   */
  await modes.getByRole('radio', { name: 'Solo listening' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/Shared listening needs a paired hub/i).first()).toBeVisible();
  await expect(modes.getByRole('radio', { name: 'Solo listening' })).toHaveAttribute('aria-checked', 'true');
});

test('settings report the same shared-listening capability the switch does', async ({ page }) => {
  await page.getByRole('option', { name: /Settings/i }).click();
  await expect(page.getByRole('heading', { name: 'Shared listening' })).toBeVisible();
  await expect(page.getByText(/needs a paired hub/i).first()).toBeVisible();
  await expect(page.getByText(/joining a group does not upload your music/i)).toBeVisible();
});

test('the hero is on every section, so the song is never more than a glance away', async ({ page }) => {
  const hero = page.getByRole('region', { name: 'Now playing' });
  await expect(hero).toBeVisible();
  await expect(hero.getByRole('heading', { name: 'Nothing playing' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Playback position' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible();

  // Still there four sections later.
  await page.getByRole('option', { name: /Equaliser/i }).click();
  await expect(hero).toBeVisible();
  await expect(page.getByRole('group', { name: 'Playback controls' })).toBeVisible();
});

test('the section strip moves with the arrow keys, like the source list it replaced', async ({ page }) => {
  const strip = page.getByRole('navigation', { name: 'Sections' });
  await strip.getByRole('option', { name: /^Music/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(strip.getByRole('option', { name: /^Now playing/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(strip.getByRole('option', { name: /^Now playing/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(strip.getByRole('option', { name: /^Settings/ })).toBeFocused();
});

test('every section is reachable and renders', async ({ page }) => {
  for (const name of ['Now playing', 'Up next', 'Playlists', 'Search', 'Constellation', 'Listening', 'Equaliser', 'Settings']) {
    await page.getByRole('option', { name: new RegExp(name, 'i') }).click();
    await expect(page.locator('.aqua-content')).toBeVisible();
    // Nothing may render a bare error boundary or an empty pane.
    await expect(page.locator('.aqua-content')).not.toHaveText('');
  }
});

test('the equaliser explains level-matched bypass and the headroom it applies', async ({ page }) => {
  await page.getByRole('option', { name: /Equaliser/i }).click();
  await expect(page.getByText(/Bypass \(level-matched\)/i)).toBeVisible();
  await expect(page.getByText(/A louder signal always sounds better/i)).toBeVisible();
  await expect(page.getByText('Headroom needed')).toBeVisible();
  // Ten bands plus a preamp, each an accessible slider, inside the band group.
  await expect(page.getByRole('group', { name: 'Equaliser bands' }).getByRole('slider')).toHaveCount(11);
});

test('the solfeggio presets are filters, and say so where the choice is made', async ({ page }) => {
  await page.getByRole('option', { name: /Equaliser/i }).click();

  const presets = page.getByLabel('Preset');
  // All nine, plus the combined one, offered alongside the tone presets rather than instead of them.
  for (const hz of [174, 285, 396, 417, 528, 639, 741, 852, 963]) {
    await expect(presets.getByRole('option', { name: new RegExp(`^${hz} Hz`) })).toHaveCount(1);
  }
  await expect(presets.getByRole('option', { name: /Bass Lift/ })).toHaveCount(1);

  await presets.selectOption({ label: '528 Hz (MI) (built in)' });

  // The claim on screen is exactly what the DSP does, and nothing more.
  await expect(page.getByText(/A narrow \+6 dB peak at 528 Hz/)).toBeVisible();
  await expect(page.getByText(/it does not add a 528 Hz tone/)).toBeVisible();
  await expect(page.getByText(/makes no claim that any frequency has a physical or medical effect/i)).toBeVisible();

  // One band at 528 Hz, not the 500 Hz graphic slider standing in for it.
  const bands = page.getByRole('group', { name: 'Equaliser bands' });
  await expect(bands.getByRole('slider')).toHaveCount(2); // preamp + the one band
  await expect(bands.getByRole('slider', { name: /528 Hz band/ })).toBeVisible();
});

test('retuning states how it is applied rather than claiming preserved tempo', async ({ page }) => {
  await page.getByRole('option', { name: /Equaliser/i }).click();
  await expect(page.getByText(/shifts the pitch of an existing recording/i)).toBeVisible();
  await expect(page.getByText(/it does not recreate what the musicians would have played/i)).toBeVisible();
});

test('settings tell the truth about Android Auto and CarPlay', async ({ page }) => {
  await page.getByRole('option', { name: /Settings/i }).click();
  await expect(page.getByText(/An app tile on the Android Auto or CarPlay home screen/i)).toBeVisible();
  await expect(page.getByText(/no web app of any kind can appear there/i)).toBeVisible();
  // And it must say what does work, not only what does not.
  await expect(page.getByText(/Track information on the lock screen and in the car/i)).toBeVisible();
});

test('sharing without a hub explains why rather than failing silently', async ({ page }) => {
  await page.getByRole('option', { name: /Settings/i }).click();
  await expect(page.getByText(/A hub is optional/i)).toBeVisible();
  await expect(page.getByText(/keeps working exactly as it does now without/i)).toBeVisible();
});

test('privacy claims are stated where a person can check them', async ({ page }) => {
  await page.getByRole('option', { name: /Settings/i }).click();
  await expect(page.getByText(/There is no analytics, no telemetry and no crash reporting/i)).toBeVisible();
  await expect(page.getByText(/Folder paths never leave this device/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete everything stored here/i })).toBeVisible();
});

test('the app is installable: manifest, icons and a service worker', async ({ page }) => {
  const manifestHref = await page.locator('link[rel=manifest]').first().getAttribute('href');
  expect(manifestHref).toBeTruthy();
  const manifest = await (await page.request.get(manifestHref!)).json();
  expect(manifest.name).toBe('Now Playing');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    expect((await page.request.get(icon.src)).status(), `${icon.src} should exist`).toBe(200);
  }
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration) || (await fetch('/sw.js')).ok;
  });
  expect(registered).toBe(true);
});

test('loads nothing from outside its own origin', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url()).origin && url.protocol !== 'data:' && url.protocol !== 'blob:') external.push(request.url());
  });
  await page.reload({ waitUntil: 'networkidle' });
  for (const name of ['Constellation', 'Listening', 'Settings']) {
    await page.getByRole('option', { name: new RegExp(name, 'i') }).click();
    await page.waitForTimeout(300);
  }
  expect(external, `the player must not fetch anything from another origin: ${external.join(', ')}`).toEqual([]);
});

test('space toggles playback and does not scroll the page', async ({ page }) => {
  // With nothing queued the transport is inert, but the key must still be handled rather than
  // scrolling the library out from under the person pressing it.
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('body').press('Space');
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});
