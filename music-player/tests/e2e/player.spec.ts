/**
 * End-to-end flows for the player, against a real production build.
 *
 * These check what a person actually experiences: the app loads with no music and says what to do,
 * the transport row carries Star / Add to playlist / Share, the equaliser explains what it is doing,
 * and every screen is reachable by keyboard. They deliberately do not stub the app's own modules —
 * a test that passes against a mock of the thing under test proves nothing.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/', import.meta.url));

/** Put real files in the library, so the list has rows made from real tags. */
async function loadFixtures(page: Page): Promise<void> {
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.wav'))
    .map((name) => `${FIXTURES}${name}`);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose files/i }).first().click();
  await (await chooser).setFiles(files);
  await expect(page.getByRole('row').filter({ hasText: 'Quiet Arithmetic' }).first()).toBeVisible({ timeout: 20_000 });
}

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
  // The window's own switch, from the screenshot this equaliser is drawn from.
  await expect(page.getByRole('checkbox', { name: 'On' })).toBeVisible();
  await expect(page.getByText(/is a level-matched bypass/i)).toBeVisible();
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


test.describe('the music list', () => {
  /*
   * The list is the reference's, not a reinterpretation of it: nine columns in its order, its
   * sortable headers, its per-row star and offline keys, its source badge. These assertions are
   * deliberately about the *columns* rather than about styling — a redesign that quietly dropped
   * BPM or the source badge would still look fine in a screenshot, and would fail here.
   */
  test('has the reference\u2019s nine columns, in its order', async ({ page }) => {
    await loadFixtures(page);
    const headers = await page.getByRole('columnheader').allTextContents();
    expect(headers.map((text) => text.replace(/[\u25b2\u25bc]/g, '').trim())).toEqual(['#', '', 'Song', 'Artist', 'Time', 'BPM', '', '', 'Album']);
  });

  test('sorts on a header, and only the sorted column says so', async ({ page }) => {
    await loadFixtures(page);
    // Song is the column the list arrives sorted on, so it starts ascending and a click flips it —
    // the reference's rule: a new column starts ascending, the same column reverses.
    const song = page.getByRole('columnheader', { name: /^Song/ });
    await expect(song).toHaveAttribute('aria-sort', 'ascending');
    const artist = page.getByRole('columnheader', { name: /^Artist/ });
    await artist.click();
    await expect(artist).toHaveAttribute('aria-sort', 'ascending');
    await artist.click();
    await expect(artist).toHaveAttribute('aria-sort', 'descending');
    // And only the sorted column says so.
    await expect(song).not.toHaveAttribute('aria-sort', /ascending|descending/);
  });

  test('stars a row, and says where each track lives', async ({ page }) => {
    await loadFixtures(page);
    const star = page.getByRole('button', { name: /^Star Quiet Arithmetic$/ });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(page.getByRole('button', { name: /Remove Quiet Arithmetic from favourites/ })).toHaveAttribute('aria-pressed', 'true');

    // The offline key is a report, not a toggle: these files came from the picker, and it says so.
    const offline = page.getByRole('button', { name: /Quiet Arithmetic was added with the file picker/ }).first();
    await expect(offline).toHaveAttribute('aria-pressed', 'false');
  });

  test('right-clicking a row opens the playlist menu', async ({ page }) => {
    await loadFixtures(page);
    await page.getByRole('row').filter({ hasText: 'Quiet Arithmetic' }).first().click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Song actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Add to Playlist' })).toBeVisible();

    await menu.getByRole('menuitem', { name: 'Add to Playlist' }).click();
    await expect(menu.getByRole('menuitem', { name: 'No playlists yet' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'New Playlist…' }).first().click();

    // The reference's alert sheet, with the song it was opened from named in it.
    const sheet = page.getByRole('dialog', { name: 'New Playlist' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Playlist name').fill('Late night');
    await sheet.getByRole('button', { name: 'Create' }).click();
    await expect(sheet).toHaveCount(0);

    await page.getByRole('option', { name: /^Playlists/ }).click();
    await expect(page.getByText('Late night').first()).toBeVisible();
  });
});

test.describe('the search popover', () => {
  test('counts the matches, offers an audition, and pages', async ({ page }) => {
    await loadFixtures(page);
    await page.getByRole('combobox').fill('a');
    const popover = page.getByRole('listbox', { name: 'Search results' });
    await expect(popover).toBeVisible();
    await expect(page.getByText(/results? in your library/)).toBeVisible();
    // The artwork tile is the fifteen-second audition, exactly as the reference has it.
    await expect(page.getByRole('button', { name: /Audition .*, 15 seconds/ }).first()).toBeVisible();

    // The arrows walk the rows without taking focus out of the field.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('combobox')).toBeFocused();
    await expect(page.getByRole('combobox')).toHaveAttribute('aria-activedescendant', /np-search-opt-/);
  });
});

test('the equaliser is the iTunes window: On, a preset menu, a preamp and ten bands', async ({ page }) => {
  await page.getByRole('option', { name: /Equaliser/i }).click();
  await expect(page.getByRole('checkbox', { name: 'On' })).toBeChecked();
  const bands = page.getByRole('group', { name: 'Equaliser bands' });
  await expect(bands.getByRole('slider', { name: 'Preamp' })).toBeVisible();
  for (const hz of [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000]) {
    await expect(bands.getByRole('slider', { name: `${hz} Hz band` })).toBeVisible();
  }
  // The scale the screenshot labels, and the caps the band labels use.
  await expect(page.getByText('+12 dB')).toBeVisible();
  await expect(page.getByText('16K')).toBeVisible();
});
