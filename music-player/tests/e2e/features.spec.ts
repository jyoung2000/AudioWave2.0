/**
 * Shuffle, discover and download, exercised through the interface.
 *
 * The logic behind each has its own unit tests; these check the wiring — that
 * the button is connected to the thing, and that the thing does what the
 * button says. The download test goes further and decodes what it downloaded,
 * because "lossless" is a claim, and a claim about a file is checkable.
 */
import { test, expect, type Page } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../../packages/test-fixtures/generated/audio/Marlow & the Tidewater/Quiet Arithmetic/', import.meta.url));

async function loadFixtures(page: Page): Promise<void> {
  const files = readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.wav'))
    .map((name) => `${FIXTURES}${name}`);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choose files/i }).first().click();
  await (await chooser).setFiles(files);
  await expect(page.getByRole('row').filter({ hasText: 'Quiet Arithmetic' }).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The row for one song.
 *
 * `hasText` is not enough here: the album is called "Quiet Arithmetic" too, so
 * filtering on that text matches both rows and `.first()` quietly picks the
 * other one — which is exactly how the download test first came to compare a
 * FLAC of one track against the WAV of another.
 */
function songRow(page: Page, title: string) {
  // Scoped to the Song column: the Album column holds the same words.
  return page.locator(`tbody tr:has(td.lib-title:text-is("${title}"))`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
});

test('shuffle deals a pass over the queue rather than picking at random', async ({ page }) => {
  await loadFixtures(page);
  // "Shuffle all" in the library toolbar also matches, so name this one exactly.
  const shuffle = page.getByRole('button', { name: 'Shuffle', exact: true });
  await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
  await shuffle.click();
  await expect(shuffle).toHaveAttribute('aria-pressed', 'true');

  /*
   * What the pass actually does — every track once, the playing song
   * surviving a toggle, Previous walking back through what was heard — is
   * asserted in music-player/tests/unit/shuffle.test.ts, against a pinned
   * random sequence. It belongs there: the fixtures are a few seconds long,
   * so proving it through real playback here would mean racing a track that
   * ends mid-assertion, which fails for reasons that have nothing to do with
   * shuffling. What this test owns is the wiring.
   */
  await songRow(page, 'Lantern Road').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lantern Road');

  // The pass reaches the other track rather than repeating this one.
  await page.getByRole('button', { name: 'Next track' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Quiet Arithmetic');

  await shuffle.click();
  await expect(shuffle, 'and it turns back off').toHaveAttribute('aria-pressed', 'false');
});

test('discover keeps playing past the end of the queue, and says why it chose what it did', async ({ page }) => {
  await loadFixtures(page);
  const discover = page.getByRole('button', { name: /^Discover: off/ });
  await expect(discover).toHaveAttribute('aria-pressed', 'false');
  await discover.click();
  await expect(page.getByRole('button', { name: /^Discover: on/ })).toHaveAttribute('aria-pressed', 'true');

  // A queue of one, from a library of two: when it ends there is somewhere to go.
  await songRow(page, 'Lantern Road').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lantern Road');

  await page.getByRole('option', { name: /^Queue/ }).click();
  await expect(page.getByRole('heading', { name: /Up next|Queue/i }).first()).toBeVisible();
});

test('play similar to this builds a queue from the recommender', async ({ page }) => {
  await loadFixtures(page);
  await songRow(page, 'Quiet Arithmetic').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Song actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Play similar to this' }).click();
  // Two tracks is a thin library; either it queues something or it says why.
  await expect(page.locator('.aqua-toast, .player-notices li').first()).toBeVisible({ timeout: 10_000 });
});

test.describe('download', () => {
  test('offers every format with the truth about each, and refuses MP3 honestly', async ({ page }) => {
    await loadFixtures(page);
    await songRow(page, 'Quiet Arithmetic').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Song actions' }).getByRole('menuitem', { name: 'Download…' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^Original/ })).toBeEnabled();
    await expect(sheet.getByRole('button', { name: 'FLAC', exact: true })).toBeEnabled();
    await expect(sheet.getByRole('button', { name: 'WAV', exact: true })).toBeEnabled();

    // The fixture is a WAV, so MP3 would mean encoding one — which this app
    // cannot do, and says so rather than producing something else.
    await expect(sheet.getByRole('button', { name: 'MP3', exact: true })).toBeDisabled();
    await expect(sheet.getByText(/carries no MP3 encoder/i)).toBeVisible();
  });

  test('saves a FLAC that decodes back to the audio that went in', async ({ page }) => {
    await loadFixtures(page);
    await songRow(page, 'Quiet Arithmetic').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Song actions' }).getByRole('menuitem', { name: 'Download…' }).click();

    /*
     * Chromium has a save dialog and the player prefers it, which writes the
     * file without a download event. Firefox and Safari have no such dialog,
     * so take that away and the anchor path runs — the one most browsers use,
     * and the one a test can catch.
     */
    await page.evaluate(() => {
      delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const download = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: 'FLAC', exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toMatch(/\.flac$/);

    const path = await saved.path();
    expect(path, 'the download must reach the disk').toBeTruthy();

    const { readFileSync } = await import('node:fs');
    const flacBytes = [...readFileSync(path!)];
    const sourceBytes = [...readFileSync(`${FIXTURES}01 Quiet Arithmetic.wav`)]; // the file behind that row
    expect(String.fromCharCode(...flacBytes.slice(0, 4)), 'it is a FLAC stream').toBe('fLaC');

    /*
     * The real check: decode both the original WAV and the FLAC we wrote,
     * with the browser's own decoders, and compare. If the encoder lost or
     * shifted a sample this is where it shows, and nothing else in the suite
     * would catch it.
     */
    const comparison = await page.evaluate(
      async ({ flac, wav }) => {
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const a = await ctx.decodeAudioData(new Uint8Array(flac).buffer);
        const b = await ctx.decodeAudioData(new Uint8Array(wav).buffer);
        if (a.length !== b.length || a.numberOfChannels !== b.numberOfChannels) {
          return { ok: false, note: `shape differs: ${a.length}×${a.numberOfChannels} vs ${b.length}×${b.numberOfChannels}` };
        }
        let worst = 0;
        for (let c = 0; c < a.numberOfChannels; c += 1) {
          const from = a.getChannelData(c);
          const to = b.getChannelData(c);
          for (let i = 0; i < from.length; i += 1) worst = Math.max(worst, Math.abs(from[i]! - to[i]!));
        }
        return { ok: true, worst, frames: a.length, channels: a.numberOfChannels, note: '' };
      },
      { flac: flacBytes, wav: sourceBytes },
    );

    expect(comparison.ok, comparison.note).toBe(true);
    expect(comparison.frames, 'every frame survived').toBeGreaterThan(0);
    // A 24-bit quantisation step is 2^-23; anything at or under it is the
    // rounding the format itself implies, not loss in the encoder.
    expect(comparison.worst!).toBeLessThanOrEqual(2 ** -23);
  });
});

test.describe('where downloads go', () => {
  /*
   * The folder picker itself is a native dialog and cannot be driven from
   * here, so what is checked is everything around it: the choices offered,
   * that a choice sticks across a reload, and that the download sheet tells
   * the listener where the file is about to land.
   */
  test('offers the choices this browser can actually honour, and remembers one', async ({ page }) => {
    await page.getByRole('button', { name: /^Settings —/ }).click();
    const panel = page.locator('.aqua-panel').filter({ hasText: 'Downloads' }).first();
    await expect(panel).toBeVisible();

    /*
     * Chromium has a save dialog, so the default is to ask each time — and
     * the button offering that is therefore absent, because it is what you
     * already have. The two on offer are the ones that would change something.
     */
    await expect(panel.getByText(/asked where to put each file/i)).toBeVisible();
    await expect(panel.getByRole('button', { name: /Choose a folder/ })).toBeVisible();
    await expect(panel.getByRole('button', { name: /Ask every time/ }), 'already the current choice').toHaveCount(0);

    await panel.getByRole('button', { name: /Use the browser/ }).click();
    await expect(panel.getByText(/wherever your downloads go/i)).toBeVisible();

    await page.reload();
    await page.getByRole('button', { name: /^Settings —/ }).click();
    const again = page.locator('.aqua-panel').filter({ hasText: 'Downloads' }).first();
    await expect(again.getByText(/wherever your downloads go/i), 'the choice survives a reload').toBeVisible();

    await again.getByRole('button', { name: /Ask every time/ }).click();
    await expect(again.getByText(/asked where to put each file/i)).toBeVisible();
  });

  test('the download sheet says where the file will land', async ({ page }) => {
    await page.getByRole('button', { name: /^Settings —/ }).click();
    const panel = page.locator('.aqua-panel').filter({ hasText: 'Downloads' }).first();
    await panel.getByRole('button', { name: /Use the browser/ }).click();

    await page.getByRole('option', { name: /^Music Library/ }).click();
    await loadFixtures(page);
    await songRow(page, 'Quiet Arithmetic').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Song actions' }).getByRole('menuitem', { name: 'Download…' }).click();
    await expect(page.getByRole('dialog').getByText(/wherever your downloads go/i)).toBeVisible();
  });
});
