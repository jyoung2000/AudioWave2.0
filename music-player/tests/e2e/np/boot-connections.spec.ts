/**
 * What is already connected should say so the moment the player has finished loading, without the
 * listener opening Settings or pressing Connect. The Hub managed this because its status notifies
 * subscribers; the paired Companion did not -- the boot probe's answer was dropped on the floor and
 * the card only ever understood the legacy helper.
 */
import { expect, test } from '@playwright/test';
import { CORS, boot } from './_shell';

const COMPANION = 'http://127.0.0.1:17999';
test.describe.configure({ timeout: 120_000 });

const HEALTH = {
  helper: 'now-playing-local-helper', protocol: 1, version: '0.1.0', servesApp: false,
  tools: [
    { id: 'yt-dlp', present: true, version: '2026.08.19', origin: 'installed', installHint: null, installable: true, setup: { state: 'ready' } },
    { id: 'spotdl', present: true, version: '4.5.2', origin: 'installed', installHint: null, installable: true, setup: { state: 'ready' } },
    { id: 'ffmpeg', present: true, version: 'n9.0.1', origin: 'path', installHint: null, installable: true, setup: { state: 'ready' } },
  ],
  allowedHosts: ['youtube.com', 'soundcloud.com'],
  formats: ['original', 'mp3'],
  startedAt: new Date().toISOString(),
};

/** A Companion paired over AWSP: no address of its own, reached through the relay. */
async function pairedCompanion(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((health) => {
    const w = window as unknown as { NP_AWSP_FAKE: unknown };
    w.NP_AWSP_FAKE = {
      status: async () => ({ paired: true, status: 'connected', serverName: "Sam's PC" }),
      connect: async () => ({ ok: true }),
      connectionType: () => 'relay',
      companion: async (method: string) => (method === 'tools.status' ? health : {}),
      on: () => undefined,
      forget: async () => undefined,
    };
  }, HEALTH);
}

test('a paired Companion reports itself as soon as the player has loaded', async ({ page }) => {
  await pairedCompanion(page);
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await boot(page);
  // Hand the shell the paired transport the way the real AWSP chunk would.
  await page.evaluate(() => {
    const w = window as unknown as { NP_AWSP: unknown; NP_AWSP_FAKE: unknown; npBootConnections?: () => Promise<void> };
    w.NP_AWSP = w.NP_AWSP_FAKE;
    return w.npBootConnections?.();
  });

  /* Nobody has opened Settings or pressed Connect: the dot and the facts must already be right.
     Before the fix this stayed "off" while detect() was returning a working Companion. */
  await expect.poll(async () => page.locator('#connAppDot').getAttribute('data-state'), { timeout: 20_000 })
    .toBe('ok');
  await expect(page.locator('#cfgConnMsg')).toContainText(/Connected/i);

  // It is named as the paired Companion rather than as an address, because it has none.
  await boot(page, '#settings/src');
  await page.evaluate(() => {
    const w = window as unknown as { NP_AWSP: unknown; NP_AWSP_FAKE: unknown; npBootConnections?: () => Promise<void> };
    w.NP_AWSP = w.NP_AWSP_FAKE;
    return w.npBootConnections?.();
  });
  await expect.poll(async () => page.locator('#connAppDot').getAttribute('data-state'), { timeout: 20_000 }).toBe('ok');
  await expect(page.locator('#connAppFacts')).toContainText(/Paired/i);
  await expect(page.locator('#connAppFacts'), 'the downloaders it reported').toContainText(/yt-dlp/);
});

test('with nothing paired the Companion card still says so plainly', async ({ page }) => {
  await page.route(/radio-browser\.info/i, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await boot(page);
  await page.evaluate(() => {
    const w = window as unknown as { npBootConnections?: () => Promise<void> };
    return w.npBootConnections?.();
  });
  /* An absent Companion is the ordinary case for most people and must not be dressed up as a
     failure: off, not bad. */
  await page.waitForTimeout(1500);
  expect(await page.locator('#connAppDot').getAttribute('data-state')).toBe('off');
});
