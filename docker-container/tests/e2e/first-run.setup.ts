/**
 * Flow 1, in a browser: first run, start to finish.
 *
 * This is a Playwright *setup* project: it walks the whole first-run gate and then saves the
 * signed-in session for the rest of the suite. Two reasons it is shaped that way rather than as a
 * helper each test calls. The first-run state exists exactly once, so it belongs in one ordered
 * walk. And the hub rate-limits `/auth/login` to ten attempts — signing in once per test would
 * exhaust that and turn a working security control into a flaky suite.
 *
 * The assertions that matter most are the ones made with `request`, which bypasses the interface
 * entirely. The DOM tests already show the shell hides everything until the password is changed;
 * what they cannot show is whether the *server* agrees. A gate a person can walk around by calling
 * the API directly is not a gate.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test as setup } from '@playwright/test';
import { AUTH_STATE, STRONG_PASSWORD } from './shared.js';

setup('first run', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Airwave Hub' })).toBeVisible();
  // Signed out, it is already the hub's window: the six tabs are there, and none of them opens.
  for (const name of ['Overview', 'Devices', 'Music', 'Groups', 'Sharing', 'System']) await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-disabled', 'true');
  // The credentials are stated rather than left for someone to guess or search for.
  await expect(page.getByText(/First run/)).toBeVisible();

  // ---- the server's own gate, with a valid session and CSRF token, skipping the interface ----
  const login = await request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'admin' } });
  expect(login.status()).toBe(200);
  const session = (await login.json()) as { csrfToken: string; mustChangePassword: boolean };
  expect(session.mustChangePassword).toBe(true);

  const headers = { 'x-csrf-token': session.csrfToken };
  for (const call of [
    { url: '/api/v1/pairing/sessions', data: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 } },
    { url: '/api/v1/providers/subsonic/test', data: {} },
    { url: '/api/v1/groups', data: { name: 'Kitchen' } },
  ]) {
    const response = await request.post(call.url, { data: call.data, headers });
    expect(response.status(), `${call.url} should be gated until the password is changed`).toBe(403);
    const problem = (await response.json()) as { detail?: string };
    // And it says why, so an operator is not left guessing at a bare 403.
    expect(problem.detail ?? '', `${call.url} should say why it refused`).toMatch(/password/i);
  }

  // ---- the interface: signing in with admin/admin leads to the gate, in the same window ----
  await page.getByLabel('Password:').fill('admin');
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByRole('heading', { name: 'Choose a real password' })).toBeVisible();
  await expect(page.getByText(/no pairing, no providers, no group listening, no Discord bot and no remote access/i)).toBeVisible();
  // Overview is open; the other five tabs are shown, locked, and say why.
  await expect(page.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Devices', 'Music', 'Groups', 'Sharing', 'System']) {
    const tab = page.getByRole('tab', { name });
    await expect(tab).toHaveAttribute('aria-disabled', 'true');
    await expect(tab).toHaveClass(/locked/);
    await tab.click({ force: true });
    await expect(tab).toHaveAttribute('aria-selected', 'false');
  }
  await expect(page.locator('#tools-locked')).toHaveText('Choose a real password first.');
  // A link straight to a locked tab does not open it either.
  await page.goto('/#devices');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose a real password' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start Pairing/ })).toHaveCount(0);
  // The overview behind the gate is real: it reads only what the server answers before setup.
  await expect(page.locator('.tile h3')).toHaveText(['Hub', 'Devices', 'Groups', 'Library', 'Providers', 'Storage']);
  await expect(page.getByText('This panel could not be displayed')).toHaveCount(0);

  const gate = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(gate.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), 'the first-run gate has no detectable accessibility violations').toEqual([]);

  // ---- a weak password is refused, with a reason a person can act on ----
  // The page was reloaded, so the password typed at sign-in is gone and the gate asks for it.
  await page.getByLabel('Current password').fill('admin');
  await page.getByLabel('New password', { exact: true }).fill('password1234');
  await page.getByLabel('New password again').fill('password1234');
  await page.getByRole('button', { name: 'Set Password' }).click();
  await expect(page.getByText(/common|guess|word/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose a real password' })).toBeVisible();

  // ---- a real one opens the hub ----
  await page.getByLabel('New password', { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel('New password again').fill(STRONG_PASSWORD);
  await page.getByRole('button', { name: 'Set Password' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a real password' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Devices' })).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('tab', { name: 'Devices' }).click();
  await expect(page.getByRole('button', { name: 'Start Pairing…' })).toBeEnabled();

  // ---- and the bootstrap password is gone for good, at the API ----
  expect((await request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'admin' } })).status()).toBe(401);
  expect((await request.post('/api/v1/auth/login', { data: { username: 'admin', password: STRONG_PASSWORD } })).status()).toBe(200);

  await page.context().storageState({ path: AUTH_STATE });
});
