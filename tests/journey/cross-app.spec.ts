/**
 * One journey across two real applications, in order (master prompt Phase 5 / part 2 Step E).
 *
 * Everything else in this repository tests one application at a time. The player's own suites stub
 * the hub with route interception written against the contract — the right shape for testing the
 * player, and the reason nothing has ever checked that the player's assumptions and the hub's real
 * behaviour agree. This is the only place they meet: a pairing code minted by the hub and typed into
 * the player, a verification code the hub's operator must type back before any credential is issued,
 * an invite link the hub's GUI composes and the player's own hash router consumes, and a name the hub
 * refuses because someone else already has it.
 *
 * **One test, with `test.step()` phases.** The first attempt at this was five tests, which cannot
 * work: Playwright gives every *test* its own browser context, so step 2 opened a page that was
 * signed out of the hub step 1 had just set up, and no paired credential could have survived to
 * step 3 either. A journey is one session by definition — one context, one hub session, one paired
 * player — and the steps still report individually.
 *
 * The hub is driven through its GUI where a person would use the GUI, and through its API where a
 * person would read a value off a screen — creating the pairing code is a GUI act, but reading back
 * whether an invite is `declined` is checked at the API, because a table that renders the right word
 * over the wrong state would pass a DOM assertion.
 */
import { expect, request as apiRequest, test, type APIRequestContext, type Page } from '@playwright/test';
import { HUB_URL, PLAYER_URL } from './playwright.config.js';

/** Long enough to pass the hub's own weak-password denylist, which is part of what step 1 proves. */
const PASSWORD = 'seven-copper-lantern-moth';
const PLAYER_NAME = 'Kitchen player';

/** Sign in at the API and keep the CSRF token; the hub rate-limits logins, so this happens once. */
async function signIn(request: APIRequestContext): Promise<string> {
  const login = await request.post(`${HUB_URL}/api/v1/auth/login`, { data: { username: 'admin', password: PASSWORD } });
  expect(login.status(), 'the admin sign-in the rest of the journey depends on').toBe(200);
  return ((await login.json()) as { csrfToken: string }).csrfToken;
}

/**
 * The player's Sources ▸ Connections pane, where a hub address and a pairing code are entered.
 *
 * Settings is a page with its own address in the shell, so it is navigated to rather than revealed:
 * unhiding `#prefs` by hand leaves `#cfgHub` in the DOM but not visible, and Playwright will not
 * type into something a person could not see — which is the right refusal, and how this was found.
 */
async function openConnections(page: Page): Promise<void> {
  await page.goto(`${PLAYER_URL}/#settings/src`);
  await page.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY, null, { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as { NP_READY: Promise<void> }).NP_READY);
  await expect(page.locator('#cfgHub')).toBeVisible({ timeout: 60_000 });
}

/**
 * Pairs a device at the API alone — session, claim, confirm, complete — the sequence the GUI walked
 * in step 02, used only where the journey needs a second identity.
 */
async function pairOverApi(admin: APIRequestContext, device: APIRequestContext, csrf: string, deviceName: string): Promise<string> {
  const csrfHeader = { 'x-csrf-token': csrf };
  const session = await admin.post(`${HUB_URL}/api/v1/pairing/sessions`, {
    headers: csrfHeader,
    data: { deviceKind: 'player', scopes: ['group:member', 'profile:read', 'profile:write'], ttlSeconds: 600 },
  });
  expect(session.status(), `a pairing session for the second player (${session.status()} ${await session.text()})`).toBe(201);
  const { sessionId, code } = (await session.json()) as { sessionId: string; code: string };
  const claim = await device.post(`${HUB_URL}/api/v1/pairing/claim`, {
    data: { code, deviceName, deviceKind: 'player', publicKey: 'journey-second-player-0000000000', appVersion: '0.1.0', protocolVersion: 1 },
  });
  expect(claim.status(), `the second player claims the code (${claim.status()} ${await claim.text()})`).toBe(200);
  const { claimSecret, verificationFingerprint } = (await claim.json()) as { claimSecret: string; verificationFingerprint: string };
  const confirm = await admin.post(`${HUB_URL}/api/v1/pairing/sessions/${sessionId}/confirm`, { headers: csrfHeader, data: { verificationFingerprint } });
  expect(confirm.status(), `the operator confirms the second player (${confirm.status()} ${await confirm.text()})`).toBe(200);
  const complete = await device.post(`${HUB_URL}/api/v1/pairing/complete`, { data: { sessionId, claimSecret } });
  expect(complete.status(), `the second player receives a credential (${complete.status()} ${await complete.text()})`).toBe(200);
  const cred = (await complete.json()) as { credentialId: string; secret: string };
  return `Bearer ${cred.credentialId}.${cred.secret}`;
}

test('the whole pass: hub set up, player paired, group joined, invite declined, name taken, group owned, someone found', async ({ page, context, request }) => {
  // The whole journey, including the hub's real pairing poll, which the player runs every 2 s.
  test.setTimeout(600_000);
  const hub = page;
  const player = await context.newPage();
  // Device calls travel without the operator's session cookie — as they do from a real player —
  // otherwise the hub rightly refuses an unsafe request that carries a cookie but no CSRF token.
  const device = await apiRequest.newContext();
  let csrf = '';
  let groupId = '';
  let playerAuth = '';
  let otherAuth = '';

  await test.step('01 — the hub is set up, and its bootstrap password stops working', async () => {
    await hub.goto('/');
    await expect(hub.getByRole('heading', { name: 'Now Playing Hub' })).toBeVisible();
    await hub.getByLabel('Password', { exact: true }).fill('admin');
    await hub.getByRole('button', { name: 'Sign in' }).click();
    await expect(hub.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
    await hub.getByLabel('Current password').fill('admin');
    await hub.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await hub.getByLabel('Repeat new password', { exact: true }).fill(PASSWORD);
    await hub.getByRole('button', { name: 'Set password' }).click();
    await expect(hub.getByRole('tab', { name: 'Devices' })).toBeVisible();

    // The gate is the server's, not the interface's.
    expect((await request.post(`${HUB_URL}/api/v1/auth/login`, { data: { username: 'admin', password: 'admin' } })).status()).toBe(401);
    csrf = await signIn(request);
  });

  await test.step('02 — the player pairs with the real hub, its verification code typed into the hub', async () => {
    // A person reads the code off the hub's Devices tab, so it is made there.
    await hub.getByRole('tab', { name: 'Devices' }).click();
    // Not in the default set: without it the hub refuses every invite this player will later make.
    // The Aqua checkbox's input is a 1 px, opacity-0 element behind a drawn box, so it is ticked the
    // way a person ticks it — by its label — and the state is then asserted rather than assumed.
    await hub.getByText('Manage groups', { exact: true }).click();
    await expect(hub.getByLabel('Manage groups')).toBeChecked();
    await hub.getByRole('button', { name: /Create pairing code/i }).click();
    const code = (await hub.getByLabel('Pairing code').innerText()).trim();
    expect(code, 'ten Crockford base32 characters, grouped for reading aloud').toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);

    // The player is told where the hub is, tests it, then claims the code.
    await openConnections(player);
    await player.fill('#cfgHub', HUB_URL);
    await player.click('#hubTest');
    await expect(player.locator('#hubMsg')).not.toHaveText('', { timeout: 30_000 });
    await player.fill('#hubCode', code.replace(/-/g, ''));
    await player.click('#hubPairBtn');

    // The hub issues nothing until the operator types back what the device is showing.
    const fingerprint = (await player.locator('#hubPairMsg .pf__fp').innerText({ timeout: 30_000 })).trim();
    expect(fingerprint.length, 'the player shows a verification code to compare').toBeGreaterThanOrEqual(4);
    await hub.getByLabel('Verification code').fill(fingerprint);
    await hub.getByRole('button', { name: 'Confirm', exact: true }).click();

    // Only now does the player hold a credential.
    await expect(player.locator('#hubUnpair')).toBeVisible({ timeout: 120_000 });
    const paired = await player.evaluate(async () => {
      const kv = (window as unknown as { kv: { get(k: string): Promise<unknown> } }).kv;
      return (await kv.get('player:hub')) as { credentialId?: string; deviceId?: string; secret?: string; scopes?: string[] } | null;
    });
    expect(paired?.credentialId, 'the player kept the credential the hub issued').toBeTruthy();
    expect(paired?.secret, 'and the secret it authenticates with').toBeTruthy();
    expect(paired?.scopes, 'and the permissions the operator ticked, which the shell reads before offering to invite').toContain('group:admin');
    playerAuth = `Bearer ${paired?.credentialId}.${paired?.secret}`;
  });

  await test.step('03 — a group made in the hub GUI, invited to with a link the player opens', async () => {
    await hub.getByRole('tab', { name: 'Groups' }).click();
    await hub.getByLabel('New group’s name').fill('Kitchen journey');
    await hub.getByRole('button', { name: 'New Group' }).click();
    await expect(hub.getByRole('heading', { name: 'Invites to Kitchen journey' })).toBeVisible();

    await hub.getByLabel('Joins as:').selectOption('guest');
    await hub.getByRole('button', { name: 'Make Invite Link' }).click();
    // A link only once the hub knows where players open the app — and here that is a real address
    // serving the real player, which is why this suite runs two servers.
    await hub.getByLabel('Players open Now Playing at:').fill(`${PLAYER_URL}/`);
    const link = await hub.getByLabel('Invite link').inputValue();
    expect(link, 'an invite link pointing at the running player').toContain(`${PLAYER_URL}/#invite/`);

    await player.goto(link);
    await expect(player.locator('#inv')).toBeVisible({ timeout: 60_000 });
    await expect(player.locator('#invGroup')).toContainText('Kitchen journey');
    await player.click('#invAccept');

    // The hub is the authority on membership, so it is asked rather than the interface believed.
    await expect
      .poll(
        async () => {
          const list = await request.get(`${HUB_URL}/api/v1/groups`, { headers: { 'x-csrf-token': csrf } });
          const body = (await list.json()) as { items?: Array<{ id: string; name: string; members?: unknown[] }> };
          const group = body.items?.find((g) => g.name === 'Kitchen journey');
          groupId = group?.id ?? '';
          return group?.members?.length ?? 0;
        },
        { message: 'the hub records the player as a member of the group it joined', timeout: 90_000 },
      )
      .toBeGreaterThan(0);
  });

  await test.step('04 — a directed invite is declined in the player and reads declined in the hub', async () => {
    expect(groupId, 'step 03 left a group to invite to').not.toBe('');
    // A directed invite is addressed to a *profile*, so the player is asked who it is — with the
    // very credential the hub issued in step 02, which is the first time that credential is used
    // outside the shell's own code.
    const me = await device.get(`${HUB_URL}/api/v1/profiles/me`, { headers: { authorization: playerAuth } });
    expect(me.status(), 'the paired credential authenticates a device request').toBe(200);
    const profileId = ((await me.json()) as { id: string }).id;

    const invite = await request.post(`${HUB_URL}/api/v1/groups/${groupId}/invites`, {
      headers: { 'x-csrf-token': csrf },
      data: { role: 'guest', toProfileId: profileId },
    });
    expect([200, 201], `a directed invite was created (${invite.status()})`).toContain(invite.status());

    // The inbox lives in Settings ▸ Profile; at the root route it is in the DOM but hidden, and
    // Playwright will not click a button a person could not see. Only a *pending* invite renders
    // Decline (anything settled renders Remove), so finding it also proves the row's state — the
    // "Joined" row from step 03 sits in the same list and must not satisfy this.
    await player.goto(`${PLAYER_URL}/#settings/profile`);
    await player.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY, null, { timeout: 60_000 });
    const pending = player.locator('#invIn li:not(.is-done)', { hasText: /Kitchen journey/i });
    await expect(pending, 'the directed invite reached the player’s inbox as pending').toBeVisible({ timeout: 90_000 });
    await pending.locator('[data-inv="decline"]').click();

    // Declined is a state on the hub, not a message in the player.
    await expect
      .poll(
        async () => {
          const list = await request.get(`${HUB_URL}/api/v1/groups/${groupId}/invites`, { headers: { 'x-csrf-token': csrf } });
          const body = (await list.json()) as { items?: Array<{ state?: string }> };
          return (body.items ?? []).map((i) => i.state ?? '').join(',');
        },
        { message: 'the hub records the invite as declined', timeout: 90_000 },
      )
      .toContain('declined');
  });

  await test.step('05 — a profile name is taken on the hub, and a second player’s claim is refused', async () => {
    // The player takes its name the way a person does: typed into Settings ▸ Profile and saved.
    await player.fill('#pfName', PLAYER_NAME);
    await player.click('#pfSave');
    await expect
      .poll(
        async () => {
          const me = await device.get(`${HUB_URL}/api/v1/profiles/me`, { headers: { authorization: playerAuth } });
          return ((await me.json()) as { displayName?: string }).displayName ?? '';
        },
        { message: 'the hub holds the name the player saved', timeout: 60_000 },
      )
      .toBe(PLAYER_NAME);

    // Uniqueness is only visible from *another* identity — the hub's availability check excludes
    // the caller's own profile — so a second player is paired over the API, the same four calls
    // the GUI made in step 02, and it is this player that is refused.
    otherAuth = await pairOverApi(request, device, csrf, 'Second player');
    const free = await device.get(`${HUB_URL}/api/v1/profiles/available?name=${encodeURIComponent(PLAYER_NAME)}`, { headers: { authorization: otherAuth } });
    expect(free.status()).toBe(200);
    expect(((await free.json()) as { available?: boolean }).available, 'the name the player took is not available to another').toBe(false);
    const claim = await device.patch(`${HUB_URL}/api/v1/profiles/me`, { headers: { authorization: otherAuth }, data: { displayName: PLAYER_NAME } });
    expect(claim.status(), 'the second claim on the same name is refused').toBe(409);
  });

  await test.step('06 — the player owns a group: makes an invite link, withdraws it, then leaves the other group', async () => {
    // Until now the hub's operator made every group. These are the player's own acts, the ones
    // np/groups.spec.ts proves against a stub: New Group, Make Invite Link, Withdraw, Leave.
    await player.goto(`${PLAYER_URL}/#settings/profile`);
    await player.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY, null, { timeout: 60_000 });
    await player.click('#grpNew');
    await player.keyboard.type('Player’s own');
    await player.keyboard.press('Enter');
    const ownRow = player.locator('#grpList li', { hasText: 'Player’s own' });
    await expect(ownRow, 'the group the player created is listed, and it is the owner').toContainText(/owner/i, { timeout: 30_000 });

    let ownId = '';
    await expect
      .poll(
        async () => {
          const list = await request.get(`${HUB_URL}/api/v1/groups`, { headers: { 'x-csrf-token': csrf } });
          const body = (await list.json()) as { items?: Array<{ id: string; name: string }> };
          ownId = body.items?.find((g) => g.name === 'Player’s own')?.id ?? '';
          return ownId;
        },
        { message: 'the hub has the group the player made', timeout: 30_000 },
      )
      .not.toBe('');

    await ownRow.locator('[data-grp="link"]').click();
    const link = await ownRow.locator('.grp__link input').inputValue({ timeout: 30_000 });
    expect(link, 'the player composed an invite link the hub issued the code for').toContain('#invite/');
    await player.locator('#invOut li', { hasText: 'Player’s own' }).locator('[data-out="withdraw"]').click();
    await expect
      .poll(
        async () => {
          const list = await request.get(`${HUB_URL}/api/v1/groups/${ownId}/invites`, { headers: { 'x-csrf-token': csrf } });
          const body = (await list.json()) as { items?: Array<{ state?: string }> };
          return (body.items ?? []).map((i) => i.state ?? '').join(',');
        },
        { message: 'the hub records the withdrawn invite', timeout: 30_000 },
      )
      .toContain('withdrawn');

    // A guest may leave; the hub's group list is what says whether it happened.
    await player.locator(`#grpList li[data-g="${groupId}"] [data-grp="leave"]`).click();
    await expect
      .poll(
        async () => {
          const list = await request.get(`${HUB_URL}/api/v1/groups`, { headers: { 'x-csrf-token': csrf } });
          const body = (await list.json()) as { items?: Array<{ id: string; members?: Array<{ displayName: string; revokedAt: string | null }> }> };
          const group = body.items?.find((g) => g.id === groupId);
          return (group?.members ?? []).filter((m) => m.revokedAt === null && m.displayName === PLAYER_NAME).length;
        },
        { message: 'the hub no longer counts the player among the group’s members', timeout: 30_000 },
      )
      .toBe(0);
  });

  await test.step('07 — another player is found from search and its profile opens', async () => {
    const named = await device.patch(`${HUB_URL}/api/v1/profiles/me`, { headers: { authorization: otherAuth }, data: { displayName: 'Second player' } });
    expect(named.status(), `the second player takes a name of its own (${named.status()})`).toBe(200);

    await player.goto(`${PLAYER_URL}/`);
    await player.waitForFunction(() => (window as unknown as { NP_READY?: unknown }).NP_READY, null, { timeout: 60_000 });
    await player.fill('#q', 'Second');
    await player.keyboard.press('Enter');
    const person = player.locator('#srchPeople [data-person]', { hasText: 'Second player' });
    await expect(person, 'search lists people on the real hub').toBeVisible({ timeout: 30_000 });
    await person.click();
    await expect(player.locator('#pfv')).toBeVisible();
    await expect(player.locator('#pfvName'), 'their profile opens in a sheet with the name the hub holds').toHaveText('Second player');
  });

  await device.dispose();
});
