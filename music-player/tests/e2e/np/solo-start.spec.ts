import { expect, test } from '@playwright/test';
import { boot } from './_shell';

const HUB = 'http://127.0.0.1:4546';
const HUB_ID = '01920000-0000-7000-8000-000000000001';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const IDENTITY = {
  hubId: HUB_ID,
  name: 'Test Hub',
  version: '0.1.0',
  contractsVersion: '0.1.0',
  protocolVersion: 1,
  minSupportedProtocolVersion: 1,
  publicKey: 'test-public-key',
  fingerprint: 'test-fingerprint',
  bindMode: 'localhost',
  publicEndpoint: null,
  setupComplete: true,
  codeOnlyPairingAvailable: true,
};

test('starts in Solo and keeps Group unavailable without a connected Hub', async ({ page }) => {
  await boot(page);
  const solo = page.locator('.segmented__item[data-mode="solo"]');
  const group = page.locator('.segmented__item[data-mode="group"]');

  await expect(solo).toHaveAttribute('aria-checked', 'true');
  await expect(group).toHaveAttribute('aria-checked', 'false');
  await expect(group).toBeDisabled();
  expect(await page.evaluate(() => window.NP_HUB?.status().connected)).toBe(false);

  await page.click('#profile');
  await page.click('#pt-player');
  await expect(page.locator('#cfgGroup')).not.toBeChecked();
  await expect(page.locator('#cfgGroup')).toBeDisabled();
});

test('Group requires a paired reachable Hub and drops back to Solo when it disconnects', async ({ page }) => {
  let reachable = true;
  await page.route(`${HUB}/api/v1/hub`, async (route) => {
    if (!reachable) return route.fulfill({ status: 503, headers: CORS, body: '{"error":"offline"}' });
    return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(IDENTITY) });
  });
  await boot(page);
  await page.evaluate(async (hubId) => {
    const storage = (window as unknown as { storage: { set(key: string, value: unknown): Promise<void> } }).storage;
    await storage.set('player:hub', {
      base: 'http://127.0.0.1:4546',
      credentialId: 'test-credential',
      secret: 'test-secret',
      scopes: ['group:read', 'group:write'],
      hubId,
      hubName: 'Test Hub',
      hubFingerprint: 'test-fingerprint',
      deviceId: 'test-device',
      pairedAt: '2026-01-01T00:00:00.000Z',
    });
  }, HUB_ID);
  await page.waitForFunction(() => window.NP_HUB?.status().connected === true);

  const solo = page.locator('.segmented__item[data-mode="solo"]');
  const group = page.locator('.segmented__item[data-mode="group"]');
  await expect(solo).toHaveAttribute('aria-checked', 'true');
  await expect(group).toBeEnabled();
  await group.click();
  await expect(group).toHaveAttribute('aria-checked', 'true');
  await expect(solo).toHaveAttribute('aria-checked', 'false');

  reachable = false;
  await page.evaluate(async () => { await window.NP_HUB?.refresh(); });
  await expect(solo).toHaveAttribute('aria-checked', 'true');
  await expect(group).toHaveAttribute('aria-checked', 'false');
  await expect(group).toBeDisabled();
  expect(await page.evaluate(() => window.NP_HUB?.status().connected)).toBe(false);
});
