/**
 * Group data is visible to members only (admins bypass), and invite codes are single-use.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let owner: { deviceId: string; authorization: string };
let outsider: { deviceId: string; authorization: string };
let groupId: string;

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  owner = await pairDevice(hub, admin, { name: 'Owner' });
  outsider = await pairDevice(hub, admin, { name: 'Outsider' });
  const created = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: owner.authorization }, payload: { name: 'Private' } });
  expect(created.statusCode).toBe(201);
  groupId = (created.json() as { id: string }).id;
});

afterEach(async () => {
  await hub.dispose();
});

const readPaths = (id: string): string[] => [`/api/v1/groups/${id}`, `/api/v1/groups/${id}/queue`, `/api/v1/groups/${id}/history`, `/api/v1/groups/${id}/history.csv`, `/api/v1/groups/${id}/history.json`, `/api/v1/groups/${id}/sync`, `/api/v1/groups/${id}/now-playing`, `/api/v1/groups/${id}/aggregate`];

describe('group read access', () => {
  it('refuses every group read to a paired device that is not a member', async () => {
    for (const url of readPaths(groupId)) {
      const response = await hub.app.inject({ method: 'GET', url, headers: { authorization: outsider.authorization } });
      expect(response.statusCode, url).toBe(403);
      expect(response.body, url).not.toContain('Private');
    }
  });

  it('lets members and hub admins read', async () => {
    for (const url of readPaths(groupId)) {
      const asOwner = await hub.app.inject({ method: 'GET', url, headers: { authorization: owner.authorization } });
      expect(asOwner.statusCode, url).toBe(200);
      const asAdmin = await hub.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect(asAdmin.statusCode, url).toBe(200);
    }
  });

  it('grants read access once the device joins, and removes it when revoked', async () => {
    const invite = await hub.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/invites`, headers: { authorization: owner.authorization }, payload: { ttlSeconds: 600 } });
    const code = (invite.json() as { inviteCode: string }).inviteCode;
    const join = await hub.app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: { authorization: outsider.authorization }, payload: { inviteCode: code } });
    expect(join.statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: outsider.authorization } })).statusCode).toBe(200);

    const revoke = await hub.app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}/members/${outsider.deviceId}`, headers: { authorization: owner.authorization } });
    expect(revoke.statusCode).toBe(200);
    expect((await hub.app.inject({ method: 'GET', url: `/api/v1/groups/${groupId}/queue`, headers: { authorization: outsider.authorization } })).statusCode).toBe(403);
  });
});

describe('invite codes', () => {
  it('can be used exactly once', async () => {
    const third = await pairDevice(hub, admin, { name: 'Third' });
    const invite = await hub.app.inject({ method: 'POST', url: `/api/v1/groups/${groupId}/invites`, headers: { authorization: owner.authorization }, payload: { ttlSeconds: 600 } });
    const code = (invite.json() as { inviteCode: string }).inviteCode;
    const first = await hub.app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: { authorization: outsider.authorization }, payload: { inviteCode: code } });
    expect(first.statusCode).toBe(200);
    const second = await hub.app.inject({ method: 'POST', url: '/api/v1/groups/join', headers: { authorization: third.authorization }, payload: { inviteCode: code } });
    expect(second.statusCode).toBe(403);
    expect(hub.ctx.groups.membership(groupId, third.deviceId)).toBeUndefined();
  });

  it('marks an invite used only once at the repository level', () => {
    const repo = hub.ctx.repos.groups;
    const now = new Date(hub.clock.now()).toISOString();
    repo.createInvite({ id: 'inv-1', group_id: groupId, code_hash: 'h'.repeat(64), role: 'member', created_by: owner.deviceId, created_at: now, expires_at: new Date(hub.clock.now() + 60_000).toISOString() });
    expect(repo.findInviteByHash('h'.repeat(64))?.id).toBe('inv-1');
    expect(repo.markInviteUsed('inv-1', 'a', now)).toBe(true);
    expect(repo.markInviteUsed('inv-1', 'b', now)).toBe(false);
    expect(repo.findInviteByHash('h'.repeat(64))).toBeUndefined();
  });
});
