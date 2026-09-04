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
import { expect, test as setup } from '@playwright/test';
import { AUTH_STATE, STRONG_PASSWORD } from './shared.js';

setup('first run', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Now Playing Hub' })).toBeVisible();
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

  // ---- the interface: signing in with admin/admin leads to the password screen and nowhere else ----
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await expect(page.getByText(/pairing, providers, group listening, the Discord bot and remote access are all disabled/i)).toBeVisible();

  // ---- a weak password is refused, with a reason a person can act on ----
  await page.getByLabel('Current password').fill('admin');
  await page.getByLabel('New password', { exact: true }).fill('password1234');
  await page.getByLabel('Repeat new password', { exact: true }).fill('password1234');
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
  await expect(page.getByText(/common|guess|word/i).first()).toBeVisible();

  // ---- a real one opens the hub ----
  await page.getByLabel('New password', { exact: true }).fill(STRONG_PASSWORD);
  await page.getByLabel('Repeat new password', { exact: true }).fill(STRONG_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('option', { name: /^Devices\b/ })).toBeVisible();

  // ---- and the bootstrap password is gone for good, at the API ----
  expect((await request.post('/api/v1/auth/login', { data: { username: 'admin', password: 'admin' } })).status()).toBe(401);
  expect((await request.post('/api/v1/auth/login', { data: { username: 'admin', password: STRONG_PASSWORD } })).status()).toBe(200);

  await page.context().storageState({ path: AUTH_STATE });
});
