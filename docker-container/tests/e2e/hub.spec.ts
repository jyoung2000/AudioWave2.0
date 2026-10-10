/**
 * The hub's admin GUI, signed in.
 *
 * These run after `first-run.setup.ts` and reuse the session it saved, so nothing here logs in.
 * What they check is the part of the interface that makes a claim about the world: the remote
 * access table, the pairing screen, and whether the page is genuinely self-hosted.
 *
 * Navigation is by the seven tabs of the hub window (Overview · Devices · Music · Search · Groups · Sharing ·
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
  // Before a code exists the plate says so, rather than showing a sample.
  await expect(page.getByLabel('Pairing code')).toHaveText('— — —');
  await page.getByRole('button', { name: 'Start Pairing…' }).click();

  const code = page.getByLabel('Pairing code');
  await expect(code).toBeVisible();
  // Ten Crockford base32 characters — 50 bits — grouped for reading aloud. The alphabet has no I,
  // L, O or U, so there is no character a person can mistake for another when typing it in.
  await expect(code).toHaveText(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  await expect(page.getByText(/Hub fingerprint/i)).toBeVisible();
  await expect(page.getByText(/if it does not match what the device shows, do not confirm/i)).toBeVisible();

  // The verification code is twelve characters (AB12-CD34-EF56): Confirm stays off until all twelve
  // are typed, and the field has room for the dashes a person copies with them.
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Verification code').fill('AB12-CD34-EF5');
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Verification code').fill('AB12-CD34-EF56');
  await expect(page.getByLabel('Verification code')).toHaveValue('AB12-CD34-EF56');
  await expect(confirm).toBeEnabled();
});

test('a permission can be ticked before the code is made, and the session shows it was granted', async ({ page }) => {
  // The scope boxes crashed the whole panel on the first tick ("Cannot read properties of null
  // (reading 'checked')": the box was read inside the state updater, after React had released the
  // event), so no operator could ever pair a device with anything but the default set. Found by the
  // cross-app journey, which needs "Run groups" for a player that invites to its own group.
  await page.goto('/');
  await page.getByRole('tab', { name: 'Devices' }).click();
  // Every permission is said in plain words, with its id as the small suffix beside it.
  const run = page.locator('label.chk', { hasText: 'Run groups' });
  await expect(run).toHaveText('Run groups group:admin');
  await expect(page.getByRole('group', { name: 'What this device may do' }).getByRole('checkbox')).toHaveCount(18);
  await run.click();
  await expect(page.getByLabel(/^Run groups/)).toBeChecked();
  await expect(page.getByText('This panel could not be displayed')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start Pairing…' }).click();
  await expect(page.getByLabel('Pairing code')).toHaveText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  // The default set is ten permissions (eight, and playlists:use and library:sync, DEC-041); with one more ticked the pending pairing carries eleven.
  await expect(page.getByRole('list', { name: 'Pending pairings' }).getByRole('listitem').filter({ hasText: '11 permissions' })).toHaveCount(1);
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
    await expect(page.getByRole('heading', { name: 'Airwave Hub' })).toBeVisible();
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

  // Without knowing where players open the player there is a code but, honestly, no link yet.
  const link = page.getByLabel('Invite link');
  await expect(link).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Copy Link' })).toBeDisabled();
  await page.getByLabel('Players open Airwave at:').fill('https://music.example/now-playing.html');
  // A fragment: the code and the hub address never reach the server the page came from.
  await expect(link).toHaveValue(/^https:\/\/music\.example\/now-playing\.html#invite\/[0-9A-Z]+\?hub=http%3A%2F%2F(127\.0\.0\.1|localhost)%3A\d+&g=Kitchen\+e2e&from=admin&r=guest&x=\d{4}-/);

  const invites = page.getByRole('table', { name: 'Invites to Kitchen e2e' });
  await expect(invites.getByText(/Open · .* left · made by admin/)).toBeVisible();
  // Withdrawing asks first, in a sheet; Cancel leaves the invite open.
  await invites.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByRole('alertdialog', { name: 'Withdraw this invite?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(invites.getByText(/Open · .* left · made by admin/)).toBeVisible();
  await invites.getByRole('button', { name: 'Withdraw' }).click();
  await page.getByRole('alertdialog', { name: 'Withdraw this invite?' }).getByRole('button', { name: 'Withdraw' }).click();
  await expect(invites.getByText(/Withdrawn · made by admin/)).toBeVisible();
  await expect(invites.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
});

test('profiles are listed for moderation, and say who can see them', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Devices' }).click();
  await expect(page.getByRole('heading', { name: 'Profiles' })).toBeVisible();
  await expect(page.getByText(/Nobody has a profile yet|Every device paired with this hub can see these names/).first()).toBeVisible();
});

test('the window is the seven-tab hub, its status line reads the real bind address and port, and old section ids still land on a tab', async ({ page }) => {
  await page.goto('/#overview');
  const tabs = page.getByRole('tablist', { name: 'Sections' });
  await expect(tabs.getByRole('tab')).toHaveText([/^Overview/, 'Devices', 'Music', 'Search', 'Groups', 'Sharing', 'System']);
  await expect(page).toHaveTitle('Airwave Hub');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Airwave Hub');

  // The status strip says where the hub listens, from the network route, not a constant in the markup.
  const status = page.locator('.status [role="status"]');
  await expect(status).toHaveText(/(127\.0\.0\.1|0\.0\.0\.0|localhost|::):\d+ · reachable from (this machine only|your network|the internet)/);

  // The Overview tiles are the metrics route's figures.
  await expect(page.locator('.tile h3')).toHaveText(['Hub', 'Devices', 'Groups', 'Library', 'Providers', 'Storage']);

  // Every section the source list once listed opens by its id in the address, on the tab it lives in.
  await page.goto('/#diagnostics');
  await expect(page.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeInViewport();
  await page.goto('/#recommendations');
  await expect(page.getByRole('tab', { name: 'Music' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Recommendations' })).toBeInViewport();
});

test('the external media tool is shown as the hub reports it, with nothing to set up', async ({ page, request }) => {
  // The interface makes no assumption about whether the tool is on: the row says what the API says.
  const listed = (await (await request.get('/api/v1/providers')).json()) as { items: Array<{ provider: string; displayName: string; role: string; enabled: boolean }>; health: Array<{ provider: string; status: string }> };
  const tool = listed.items.find((p) => p.role === 'tool');
  expect(tool, 'the hub lists its external tool').toBeTruthy();
  const status = listed.health.find((h) => h.provider === tool!.provider)?.status ?? (tool!.enabled ? 'ok' : 'disabled');
  const word = { ok: 'Working', degraded: 'Limited', unconfigured: 'Needs setting up', disabled: 'Off', down: 'Down' }[status]!;

  await page.goto('/#providers');
  const row = page.getByRole('table', { name: 'Providers' }).getByRole('row').filter({ hasText: tool!.displayName });
  await expect(row).toContainText(`${word}:`);
  await expect(row.getByRole('button', { name: /^Set up/i })).toHaveCount(0);
  await row.getByRole('button', { name: `Details of ${tool!.displayName}` }).click();
  await expect(page.getByRole('region', { name: `${tool!.displayName} details` })).toBeVisible();
});

test('no pane scrolls sideways, at the window width the design is drawn for or at a phone width', async ({ page }) => {
  for (const viewport of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    for (const name of ['Overview', 'Devices', 'Music', 'Search', 'Groups', 'Sharing', 'System']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const overflow = await page.evaluate(() => {
        const pane = document.querySelector('.pane')!;
        return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, pane.scrollWidth - pane.clientWidth);
      });
      expect(overflow, `${name} at ${viewport.width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('the panes keep the design’s spacing: pane, groups, label column, lists and the button rows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  const css = (selector: string, props: string[]) =>
    page.evaluate(
      ([s, p]) => {
        const el = document.querySelector(s as string);
        if (!el) return null;
        const style = getComputedStyle(el);
        return (p as string[]).map((name) => style.getPropertyValue(name)).join(' ');
      },
      [selector, props] as const,
    );
  // airwave-hub.html: `.pane` 18px 20px 20px, groups 16px apart, a legend 2px over its content.
  expect(await css('.pane', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'])).toBe('18px 20px 20px 20px');
  await page.getByRole('tab', { name: 'Devices' }).click();
  expect(await css('.pane legend', ['margin-bottom'])).toBe('2px');
  // The permission list is the design's `#scopes` well: 4px 8px under its heading.
  expect(await css('fieldset.scopes', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'])).toBe('4px 8px 4px 8px');
  await page.getByRole('tab', { name: 'System' }).click();
  await expect(page.locator('#network .kv dd').first()).toBeVisible();
  // One label column per pane: the read-only list lines its values up with the controls (158px).
  const columns = await page.evaluate(() => {
    const control = document.querySelector('#network .pref > .v')!.getBoundingClientRect().left;
    const value = document.querySelector('#network .kv dd')!.getBoundingClientRect().left;
    return { control: Math.round(control), value: Math.round(value) };
  });
  expect(columns.value, 'the list’s values start where the controls do').toBe(columns.control);
  expect(await css('.pane .barrow', ['margin-top', 'column-gap'])).toBe('7px 8px');
  // The pane's foot sits a group's gap under the last list, as the companion's does.
  await page.getByRole('tab', { name: 'Overview' }).click();
  const foot = await page.evaluate(() => {
    const f = document.querySelector('.pane > .panefoot')!;
    return Math.round(f.getBoundingClientRect().top - f.previousElementSibling!.getBoundingClientRect().bottom);
  });
  expect(foot).toBe(16);
});

test('backup settings are saved with Save, the schedule says when the next one runs, and an archive downloads', async ({ page }) => {
  await page.goto('/#backup');
  const folder = page.getByLabel('Save backups to:');
  await expect(folder).toHaveValue(/\/backups$/);
  const save = page.getByRole('button', { name: 'Save', exact: true }).last();
  await expect(save).toBeDisabled();

  // Outside the data volume: said under the form, and nothing is sent.
  await folder.fill('/etc/airwave');
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Use a folder inside the data volume' })).toBeVisible();
  await page.getByRole('button', { name: 'Revert' }).last().click();
  await expect(folder).toHaveValue(/\/backups$/);

  await page.getByLabel('How often:').selectOption('weekly');
  await page.getByLabel('On', { exact: true }).selectOption('1');
  await page.getByLabel('Keep:').selectOption('4');
  await save.click();
  await expect(page.locator('.status [role="status"]')).toContainText('Saved. Next one Monday');
  await expect(page.getByLabel('Keep:')).toHaveValue('4');

  await page.getByRole('button', { name: 'Back Up Now' }).click();
  const table = page.getByRole('table', { name: 'Backups' });
  const download = table.getByRole('link', { name: /^Download backup-/ }).first();
  await expect(download).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^backup-\d{8}T\d{6}Z\.sqlite$/);
});

test('network settings wait for Save, check the address first, and say Saved.', async ({ page }) => {
  await page.goto('/#network');
  const endpoint = page.getByLabel('Public address:');
  await endpoint.fill('http://music.example.com');
  await expect(page.getByText('Not saved yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByRole('alert').filter({ hasText: 'Use an https address' })).toBeVisible();
  await endpoint.fill('');
  await page.getByLabel('IPs in logs:').selectOption('hashed');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.locator('.status [role="status"]')).toHaveText('Saved.');
  await page.getByLabel('IPs in logs:').selectOption('truncated');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.getByText('Not saved yet.')).toHaveCount(0);
});

test('the Sharing tab offers to make a link from what the hub holds, and says when there is nothing', async ({ page }) => {
  await page.goto('/#shares');
  const what = page.getByLabel('What to share');
  await expect(what).toBeVisible();
  await expect(page.getByLabel('Expires')).toHaveValue('7');
  await page.getByRole('button', { name: 'Create Link' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Choose what to share first|nothing on the hub to share/ })).toBeVisible();
});

test('Live TV from the companion is shown read-only in the Music tab', async ({ page }) => {
  await page.goto('/#downloads');
  await expect(page.getByRole('heading', { name: 'Live TV from the companion' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Live TV from the companion' })).toContainText(/Nothing yet|channel/);
});

test('provider details open under their row and Escape puts the caret back on its button', async ({ page }) => {
  await page.goto('/#providers');
  const button = page.getByRole('table', { name: 'Providers' }).getByRole('button', { name: /^(Details of|Set up) / }).first();
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const region = page.getByRole('region', { name: /details$/ });
  await expect(region).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(region).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});
