/**
 * Groups and invites (NPD-031): create a group and make an invite link on the Profile tab; the
 * invite page an invite link opens, with Join and Decline; invites received and sent listed on the
 * Profile tab; inviting someone from their profile. Ported from airwave-np tests/groups.mjs.
 *
 * What changed: the original simulated the container's group routes and left the invite routes
 * docs/hub-group-invites.md proposed as 404 unless a test turned them on, with a first pass asserting
 * the “hub can't withdraw” fallback. Those routes are real contracts in this repo
 * (packages/contracts/src/api/routes.ts: /groups/:id/invites list, create and withdraw,
 * /groups/invites/preview, /me/invites, accept and decline), so the stub always answers them as the
 * contract does and the “hub lacks this” branches are dropped: an invite link comes back with its
 * inviteId and is offered Withdraw, a code is described by the preview (unknown codes 404), and
 * /me/invites is empty unless a test addresses an invite to this profile. No demo data was involved.
 */
import { expect, test, type Page } from '@playwright/test';
import { boot, CORS, HUB, watchErrors } from './_shell';

const ACCT = { base: HUB, credentialId: '00000000-0000-4000-8000-0000000000aa', secret: 'x'.repeat(40), scopes: ['group:member', 'group:admin'], hubName: 'TOWER', deviceId: 'd1' };
type Group = { id: string; name: string; status: string; myRole: string | null; members: Array<{ memberId: string; role: string; displayName?: string; revokedAt: null }> };
type Hub = {
  directed: boolean; calls: string[]; seq: number; declined?: boolean;
  lastInvite?: { ttlSeconds: number; role: string; toProfileId?: string };
  groups: Group[]; codes: Record<string, { groupId: string; used: boolean; exp: string }>; other: Group;
};
const mkHub = (directed: boolean): Hub => ({
  directed, calls: [], seq: 1,
  groups: [{ id: 'g-1', name: 'Friday Crew', status: 'active', myRole: 'owner', members: [{ memberId: 'u-me', role: 'owner', displayName: 'jalon', revokedAt: null }, { memberId: 'u-mara', role: 'member', displayName: 'Mara', revokedAt: null }] },
    { id: 'g-2', name: 'Office Radio', status: 'active', myRole: 'member', members: [{ memberId: 'u-x', role: 'owner', revokedAt: null }] }],
  codes: { JOIN4ME77: { groupId: 'g-3', used: false, exp: new Date(Date.now() + 36e5).toISOString() } },
  other: { id: 'g-3', name: 'Night Shift', status: 'active', myRole: null, members: [] },
});

async function wire(page: Page, hub: Hub): Promise<void> {
  await page.route(HUB + '/**', async (r) => {
    const q = r.request(), u = new URL(q.url()), path = u.pathname.replace('/api/v1', ''), m = q.method();
    const json = (o: unknown, s = 200) => r.fulfill({ status: s, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    hub.calls.push(m + ' ' + path);
    let mm: RegExpMatchArray | null;
    if (path === '/profiles/me') return json({ id: 'u-me', displayName: 'jalon', avatarUrl: null, playlists: [] });
    if (path === '/profiles/u-mara') return json({ id: 'u-mara', displayName: 'Mara', avatarUrl: null, playlists: [] });
    if (path === '/groups' && m === 'GET') return json({ items: hub.groups });
    if (path === '/groups' && m === 'POST') {
      const g: Group = { id: 'g-n' + hub.seq++, name: (q.postDataJSON() as { name: string }).name, status: 'active', myRole: 'owner', members: [{ memberId: 'u-me', role: 'owner', revokedAt: null }] };
      hub.groups.push(g); return json(g, 201);
    }
    if ((mm = path.match(/^\/groups\/([^/]+)\/invites$/)) && m === 'POST') {
      const g = hub.groups.find((x) => x.id === mm![1]);
      if (!g || !['owner', 'admin'].includes(g.myRole ?? '')) return json({ error: 'forbidden' }, 403);
      const body = q.postDataJSON() as NonNullable<Hub['lastInvite']>; hub.lastInvite = body;
      const code = 'CODE' + hub.seq++ + 'XYZ'; const exp = new Date(Date.now() + body.ttlSeconds * 1000).toISOString();
      hub.codes[code] = { groupId: g.id, used: false, exp };
      // ported: the create route returns inviteId and toProfileId, as the contract has it
      return json({ inviteCode: code, expiresAt: exp, inviteId: 'inv-' + code, toProfileId: body.toProfileId ?? null });
    }
    if ((mm = path.match(/^\/groups\/([^/]+)\/invites$/)) && m === 'GET') return json({ items: [] });
    if (/^\/groups\/[^/]+\/invites\/inv-/.test(path) && m === 'DELETE') return json({ ok: true });
    if (path === '/groups/join' && m === 'POST') {
      const k = hub.codes[(q.postDataJSON() as { inviteCode: string }).inviteCode];
      if (!k || k.used) return json({ error: 'Invalid or expired invite code' }, 403);
      k.used = true; const g = { ...hub.other, myRole: 'member' }; hub.groups.push(g); return json(g);
    }
    if ((mm = path.match(/^\/groups\/([^/]+)\/leave$/))) { hub.groups = hub.groups.filter((x) => x.id !== mm![1]); return json({ ok: true }); }
    // ported: these were “proposed, 404 unless enabled”; they exist now and always answer
    if (path === '/me/invites') return json({ items: hub.directed ? [{ inviteId: 'inv-direct', groupId: 'g-9', groupName: 'Book Club Beats', fromName: 'Mara', role: 'member', expiresAt: new Date(Date.now() + 5e6).toISOString() }] : [] });
    if (path === '/me/invites/inv-direct/decline') { hub.declined = true; return json({ ok: true }); }
    if (path === '/groups/invites/preview') {
      const k = hub.codes[u.searchParams.get('code') ?? ''];
      if (!k || k.groupId !== 'g-3') return json({ error: 'Invalid or expired invite code' }, 404);
      return json({ groupName: 'Night Shift', fromName: 'Dee', memberCount: 4, expiresAt: k.exp });
    }
    return json({ error: 'nope' }, 404);
  });
}

/** Store the device account (paired or not) through kv, then open the page afresh at `hash`. */
async function start(page: Page, hub: Hub, hash = '', paired: boolean | typeof ACCT = true): Promise<void> {
  await page.route(/cdn\.jsdelivr\.net/, (r) => r.abort());
  await wire(page, hub);
  await boot(page);
  await page.evaluate(async (a) => {
    (window as unknown as { kv: { set(k: string, v: unknown): void } }).kv.set('player:hub', a);
    await new Promise((res) => setTimeout(res, 300));
  }, paired === true ? ACCT : paired || null);
  await page.goto('about:blank');
  await boot(page, hash);
  await page.waitForTimeout(500);
}

const inviteLink = (extra = '') => '#invite/JOIN4ME77?hub=' + encodeURIComponent(HUB) + '&g=Night+Shift' + extra;

let errors: string[];
test.use({ viewport: { width: 1280, height: 900 }, contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ page }) => { errors = watchErrors(page); });
test.afterEach(() => { expect(errors, 'JS errors').toEqual([]); });

test('the Profile tab: groups, a new group, an invite link, Withdraw, and Leave', async ({ page }) => {
  const hub = mkHub(false);
  await start(page, hub, '#settings/profile');
  const rows = await page.$$eval('#grpList li', (ls) => ls.map((l) => l.textContent ?? ''));
  expect(rows.length === 2 && /Friday Crew/.test(rows[0]!) && /2 members · Owner/.test(rows[0]!) && /Office Radio/.test(rows[1]!) && /Member/.test(rows[1]!), 'Profile lists your groups with members and your role: ' + JSON.stringify(rows)).toBe(true);
  expect(await page.$$eval('#grpList li', (ls) => !!ls[0]!.querySelector('[data-grp="link"]') && !ls[1]!.querySelector('[data-grp="link"]')), 'only an owner or admin is offered an invite link').toBe(true);
  expect(await page.$$eval('#grpList li', (ls) => !ls[0]!.querySelector('[data-grp="leave"]') && !!ls[1]!.querySelector('[data-grp="leave"]')), 'the owner can’t leave; a member can').toBe(true);
  await page.click('#grpNew'); await page.waitForTimeout(200);
  await page.keyboard.type('Road Trip'); await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  expect(hub.calls, 'New Group… creates it on the container').toContain('POST /groups');
  await expect(page.locator('#grpList'), 'and lists it').toContainText('Road Trip');
  await page.selectOption('#grpTtl', '3600');
  await page.click('#grpList li:first-child [data-grp="link"]'); await page.waitForTimeout(500);
  const link = await page.inputValue('#grpList .grp__link input');
  expect(hub.lastInvite?.ttlSeconds === 3600 && hub.lastInvite?.role === 'member', 'Make Invite Link asks the container for a one-hour member invite').toBe(true);
  expect(/#invite\/CODE\d+XYZ\?/.test(link) && link.includes('hub=' + encodeURIComponent(HUB)) && link.includes('g=Friday+Crew') && link.includes('from=jalon'), 'and shows a link carrying the code, container, group and sender: ' + link.slice(-110)).toBe(true);
  const out = await page.$$eval('#invOut li', (ls) => ls.map((l) => l.textContent ?? ''));
  expect(out.length === 1 && /Friday Crew/.test(out[0]!) && /anyone with the link/.test(out[0]!) && /expires in (60 min|1 hour)/.test(out[0]!) && /works once/.test(out[0]!), 'the link is listed under Sent: ' + out[0]).toBe(true);
  // ported: was “without a withdraw route, Remove says the code still works”; the route exists
  expect(await page.$$('#invOut li [data-out="withdraw"]'), 'the container can withdraw invites, so Withdraw is offered').toHaveLength(1);
  await page.click('#invOut [data-out="withdraw"]'); await page.waitForTimeout(400);
  expect(hub.calls.some((c) => /^DELETE \/groups\/g-1\/invites\/inv-/.test(c)), 'which withdraws it on the container').toBe(true);
  await expect(page.locator('#invOut')).toContainText('No invite links yet');
  await page.click('#grpList li:nth-child(2) [data-grp="leave"]'); await page.waitForTimeout(500);
  expect(hub.calls, 'Leave leaves the group').toContain('POST /groups/g-2/leave');
  await expect(page.locator('#grpList')).not.toContainText('Office Radio');
});

test('paired without “Manage groups”, no group offers an invite link — the hub would refuse it', async ({ page }) => {
  // The hub gates every invite route on group:admin; the operator grants it at pairing. A button that
  // can only be answered with 403 is not offered, and the owner row still says who owns it.
  const hub = mkHub(false);
  await start(page, hub, '#settings/profile', { ...ACCT, scopes: ['group:member'] });
  await expect(page.locator('#grpList li')).toHaveCount(2);
  await expect(page.locator('#grpList li').first()).toContainText('Owner');
  expect(await page.$$eval('#grpList [data-grp="link"]', (b) => b.length), 'no invite link on any row').toBe(0);
});

test('the invite page: from a link, Not Now, Join, a used code, a bad code, Decline', async ({ page }) => {
  const hub = mkHub(false);
  await start(page, hub, inviteLink('&from=Dee&x=' + encodeURIComponent(new Date(Date.now() + 36e5).toISOString())));
  expect(await page.isVisible('#inv'), 'an invite link opens the invite page').toBe(true);
  expect(await page.textContent('#invTitle'), 'naming the group').toBe('Join “Night Shift”?');
  await expect(page.locator('#invSub'), 'who sent it and the container').toContainText(/Dee invited you to listen together on TOWER/);
  // ported: was “the name comes from the link until the container confirms it”; the preview route
  // exists, so the container has confirmed it by the time the page settles
  expect(hub.calls.some((c) => c.startsWith('GET /groups/invites/preview')), 'the container is asked what the code is for').toBe(true);
  expect(await page.evaluate(() => location.hash), 'the code is taken out of the address bar').toBe('');
  await page.click('#invLater'); await page.waitForTimeout(200);
  expect(await page.isVisible('#inv'), 'Not Now closes it').toBe(false);
  await boot(page, '#settings/profile'); await page.waitForTimeout(500);
  const rin = await page.$$eval('#invIn li', (ls) => ls.map((l) => l.textContent ?? ''));
  expect(rin.length === 1 && /Night Shift/.test(rin[0]!) && /from Dee/.test(rin[0]!), 'and the invite waits under Received on the Profile tab: ' + JSON.stringify(rin)).toBe(true);
  await page.click('#invIn [data-inv="open"]'); await page.waitForTimeout(300);
  await page.click('#invAccept'); await page.waitForTimeout(700);
  expect(await page.isVisible('#inv'), 'Join Group joins with the code').toBe(false);
  await expect(page.locator('#grpList'), 'and the group appears').toContainText('Night Shift');
  await expect(page.locator('#invIn'), 'the invite is marked joined').toContainText('Joined');

  await page.fill('#invPaste', 'http://127.0.0.1:4173/#invite/JOIN4ME77?g=Night+Shift'); await page.click('#invOpen'); await page.waitForTimeout(300);
  await expect(page.locator('#invMsg'), 'opening it again says you already joined').toContainText(/You joined this group/);
  expect(await page.$eval('#invAccept', (x) => (x as HTMLButtonElement).disabled)).toBe(true);
  await page.click('#invLater');
  await page.fill('#invPaste', 'dead-code-99'); await page.click('#invOpen'); await page.waitForTimeout(300);
  if (await page.$eval('#invAccept', (x) => !(x as HTMLButtonElement).disabled)) { await page.click('#invAccept'); await page.waitForTimeout(500); }
  // ported: the preview now answers 404 for an unknown code, so the page may say so before Join
  await expect(page.locator('#invMsg'), 'a bad code says it has expired or was used').toContainText(/expired or was already used/);
  await page.click('#invLater');
  await page.fill('#invPaste', '#invite/OTHER123?g=Gym'); await page.click('#invOpen'); await page.waitForTimeout(300);
  await page.click('#invDecline'); await page.waitForTimeout(200);
  await expect(page.locator('#invIn'), 'Decline closes it and marks it declined').toContainText(/Gym[\s\S]*Declined/);
});

test('not paired: the invite page asks you to pair first', async ({ page }) => {
  await start(page, mkHub(false), inviteLink(), false);
  await expect(page.locator('#invMsg'), 'unpaired, the invite page asks you to pair first').toContainText(/Pair this player with 192\.168\.1\.20:4546 first/);
  expect(await page.$eval('#invAccept', (x) => (x as HTMLButtonElement).disabled), 'Join is off').toBe(true);
  expect(await page.isVisible('#invPair'), 'and Connections is offered').toBe(true);
  await page.click('#invPair'); await page.waitForTimeout(500);
  expect(await page.evaluate(() => location.hash), 'which opens Sources').toMatch(/settings\/src/);
  expect(await page.isVisible('#hubPair, #cfgHub')).toBe(true);
});

test('directed invites, Withdraw, the preview, and inviting someone from their profile', async ({ page }) => {
  const hub = mkHub(true);
  await start(page, hub, '#settings/profile');
  await page.waitForTimeout(300);
  const rin = await page.$$eval('#invIn li', (ls) => ls.map((l) => l.textContent ?? ''));
  expect(rin.length === 1 && /Book Club Beats/.test(rin[0]!) && /from Mara/.test(rin[0]!), 'invites addressed to you arrive from the container: ' + JSON.stringify(rin)).toBe(true);
  await page.click('#invIn [data-inv="decline"]'); await page.waitForTimeout(300);
  expect(hub.declined, 'a decline is sent back to it').toBe(true);
  await expect(page.locator('#invIn')).toContainText('Declined');
  await page.click('#grpList li:first-child [data-grp="link"]'); await page.waitForTimeout(500);
  expect(await page.$$('#invOut li [data-out="withdraw"]'), 'a container that can withdraw invites offers Withdraw').toHaveLength(1);
  await page.click('#invOut [data-out="withdraw"]'); await page.waitForTimeout(400);
  expect(hub.calls.some((c) => /^DELETE \/groups\/g-1\/invites\/inv-/.test(c)), 'which withdraws it on the container').toBe(true);
  await expect(page.locator('#invOut')).toContainText('No invite links yet');

  await page.fill('#invPaste', '#invite/JOIN4ME77'); await page.click('#invOpen'); await page.waitForTimeout(400);
  expect(await page.textContent('#invTitle'), 'a bare code is described by the container’s preview').toBe('Join “Night Shift”?');
  await expect(page.locator('#invSub')).toContainText(/Dee invited you/);
  await expect(page.locator('#invFacts')).toContainText(/Members\s*4/);
  await page.click('#invLater');

  await page.evaluate(() => (window as unknown as { hubPeople: { open(id: string): void } }).hubPeople.open('u-mara')); await page.waitForTimeout(600);
  expect(await page.isVisible('#pfvInv'), 'another person’s profile offers to invite them').toBe(true);
  expect(await page.$$eval('#pfvGroup option', (o) => o.map((x) => x.textContent)), 'to the groups you can invite them to').toEqual(['Friday Crew']);
  await page.click('#pfvInvite'); await page.waitForTimeout(500);
  expect(hub.lastInvite?.toProfileId, 'Send Invite addresses it to them').toBe('u-mara');
  await expect(page.locator('#pfvInvMsg')).toContainText(/waiting in Mara’s invites/);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the invite page fits', async ({ page }) => {
    await start(page, mkHub(false), inviteLink());
    const w = await page.$eval('.inv__win', (x) => { const r = x.getBoundingClientRect(); return { left: r.left, right: r.right }; });
    expect(w.left >= 0 && w.right <= 390, 'on a phone the invite window fits: ' + JSON.stringify(w)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'and the page does not scroll sideways').toBe(true);
  });
});
