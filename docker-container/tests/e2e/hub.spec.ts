/**
 * The hub's admin GUI, signed in.
 *
 * These run after `first-run.setup.ts` and reuse the session it saved, so nothing here logs in.
 * What they check is the part of the interface that makes a claim about the world: the remote
 * access table, the pairing screen, and whether the page is genuinely self-hosted.
 */
import { expect, test } from '@playwright/test';

test('the remote access page states what the hub will not do, rather than promising a tunnel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('option', { name: /^Network\b/ }).click();

  await expect(page.getByText('What works where')).toBeVisible();
  // The honest part: the hub never opens a port on the operator's behalf, and the table says so.
  await expect(page.getByText(/no UPnP, no NAT hole punching, no relay service/i)).toBeVisible();
});

test('a pairing code is high-entropy, unambiguous, and shown with a fingerprint to compare', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('option', { name: /^Devices\b/ }).click();
  await page.getByRole('button', { name: /Create pairing code/i }).click();

  const code = page.getByLabel('Pairing code');
  await expect(code).toBeVisible();
  // Ten Crockford base32 characters — 50 bits — grouped for reading aloud. The alphabet has no I,
  // L, O or U, so there is no character a person can mistake for another when typing it in.
  await expect(code).toHaveText(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  await expect(page.getByText(/Hub fingerprint/i)).toBeVisible();
  await expect(page.getByText(/if it does not match what the device shows, do not confirm/i)).toBeVisible();
});

test('the interface loads nothing from outside the hub', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.protocol !== 'data:' && url.protocol !== 'blob:') external.push(request.url());
  });

  await page.goto('/');
  await page.getByRole('option', { name: /^Diagnostics\b/ }).click();
  await page.waitForLoadState('networkidle');

  expect(external, 'the admin GUI must be entirely self-hosted: no fonts, no analytics, no CDN').toEqual([]);
});

test('a signed-out visitor is no longer offered the first-run credentials', async ({ browser }) => {
  // A fresh context with no saved session: the hint is about state, not a constant in the markup.
  const page = await browser.newPage({ storageState: { cookies: [], origins: [] } });
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Now Playing Hub' })).toBeVisible();
    await expect(page.getByText(/First run/)).toHaveCount(0);
  } finally {
    await page.close();
  }
});
