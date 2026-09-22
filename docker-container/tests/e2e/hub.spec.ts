/**
 * The hub's admin GUI, signed in.
 *
 * These run after `first-run.setup.ts` and reuse the session it saved, so nothing here logs in.
 * What they check is the part of the interface that makes a claim about the world: the remote
 * access table, the pairing screen, and whether the page is genuinely self-hosted.
 *
 * Navigation is by the six tabs of the hub window (Overview · Devices · Music · Groups · Sharing ·
 * System); a section such as Network or Profiles is a stacked part of its tab's pane.
 */
import { expect, test } from '@playwright/test';

test('the remote access page states what the hub will not do, rather than promising a tunnel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'System' }).click();

  await expect(page.getByText('What works where')).toBeVisible();
  // The honest part: the hub never opens a port on the operator's behalf, and the table says so.
  await expect(page.getByText(/no UPnP, no NAT hole punching, no relay service/i)).toBeVisible();
});

test('a pairing code is high-entropy, unambiguous, and shown with a fingerprint to compare', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Devices' }).click();
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
  await page.getByRole('tab', { name: 'System' }).click();
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

test('a group is made here, invited to with a link the player understands, and the invite withdrawn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Groups' }).click();

  await page.getByLabel('New group’s name').fill('Kitchen e2e');
  await page.getByRole('button', { name: 'New Group' }).click();
  await expect(page.getByRole('heading', { name: 'Invites to Kitchen e2e' })).toBeVisible();

  await page.getByLabel('Joins as:').selectOption('guest');
  await page.getByRole('button', { name: 'Make Invite Link' }).click();

  // Without knowing where players open Now Playing there is a code but, honestly, no link yet.
  const link = page.getByLabel('Invite link');
  await expect(link).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy Link' })).toBeDisabled();
  await page.getByLabel('Players open Now Playing at:').fill('https://music.example/now-playing.html');
  // A fragment: the code and the hub address never reach the server the page came from.
  await expect(link).toHaveValue(/^https:\/\/music\.example\/now-playing\.html#invite\/[0-9A-Z]+\?hub=http%3A%2F%2F(127\.0\.0\.1|localhost)%3A\d+&g=Kitchen\+e2e&from=admin&r=guest&x=\d{4}-/);

  const invites = page.getByRole('table', { name: 'Invites to Kitchen e2e' });
  await expect(invites.getByText(/Open · .* left · made by admin/)).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await invites.getByRole('button', { name: 'Withdraw' }).click();
  await expect(invites.getByText(/Withdrawn · made by admin/)).toBeVisible();
  await expect(invites.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
});

test('profiles are listed for moderation, and say who can see them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Devices' }).click();
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  await expect(page.getByText(/Nobody has a profile yet|Every device paired with this hub can see these names/)).toBeVisible();
});

test('the window is the six-tab hub, its status line reads the real bind address and port, and old section ids still land on a tab', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Sections' });
  await expect(tabs.locator('.admin-tab__label')).toHaveText(['Overview', 'Devices', 'Music', 'Groups', 'Sharing', 'System']);

  // The status strip says where the hub listens, from the network route, not a constant in the markup.
  const status = page.locator('.aqua-bottom-bar__status');
  await expect(status).toHaveText(/(127\.0\.0\.1|0\.0\.0\.0|localhost|::):\d+ · reachable from (this machine only|your network|the internet)/);

  // The Overview tiles are the metrics route's figures.
  await expect(page.locator('.admin-tile__heading')).toHaveText(['Hub', 'Connections', 'Groups', 'Providers', 'Storage', 'Jobs']);

  // Every section the source list once listed opens by its id in the address, on the tab it lives in.
  await page.goto('/#diagnostics');
  await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Logs' })).toBeVisible();
  await page.goto('/#recommendations');
  await expect(page.getByRole('tab', { name: 'Music' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'How recommendations work here' })).toBeVisible();
});
