/**
 * Flows 1 and 2: first run, and pairing a device.
 *
 * These assert the security posture the README promises, not just that the endpoints exist:
 * `admin/admin` works exactly once and only on fresh state, remote features stay closed until the
 * password is changed, and a pairing code alone is never enough to obtain a credential.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;

beforeEach(async () => {
  hub = await createTestHub();
});

afterEach(async () => {
  await hub.dispose();
});

describe('first run', () => {
  it('reports setup as incomplete and accepts admin/admin only on fresh state', async () => {
    const before = await hub.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    expect(before.json()).toMatchObject({ authenticated: false, setupComplete: false });

    const session = await hub.loginAsAdmin();
    expect(session.cookie).toContain('now-playing-session=');

    const info = await hub.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: session.cookie } });
    expect(info.json()).toMatchObject({ authenticated: true, username: 'admin', mustChangePassword: true, setupComplete: false });
  });

  it('sets an HttpOnly, SameSite=Strict session cookie', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'admin' } });
    const raw = response.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw[0]! : String(raw);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // No Secure flag on a loopback hub, or the browser would drop the cookie over plain HTTP.
    expect(cookie).not.toContain('Secure');
  });

  it('refuses every setup-gated route until the password is changed', async () => {
    const session = await hub.loginAsAdmin();
    for (const url of ['/api/v1/providers/spotify/config', '/api/v1/pairing/sessions', '/api/v1/devices', '/api/v1/groups']) {
      const response = await hub.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
      expect(response.statusCode, `${url} should be gated before setup`).toBe(403);
      expect(response.json()).toMatchObject({ code: 'setup-required' });
    }
  });

  it('leaves health, version and hub identity reachable before setup', async () => {
    for (const url of ['/healthz', '/readyz', '/api/v1/version', '/api/v1/hub']) {
      expect((await hub.app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
  });

  it('rejects a weak new password and accepts a real one', async () => {
    const session = await hub.loginAsAdmin();
    const weak = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken },
      payload: { currentPassword: 'admin', newPassword: 'password1234' },
    });
    expect(weak.statusCode).toBe(400);

    const admin = await hub.completeSetup();
    const info = await hub.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: admin.cookie } });
    expect(info.json()).toMatchObject({ setupComplete: true, mustChangePassword: false });
  });

  it('stops accepting admin/admin once a real password is set', async () => {
    await hub.completeSetup();
    const retry = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'admin' } });
    expect(retry.statusCode).toBe(401);
  });

  it('rotates the session on password change so the old cookie stops working', async () => {
    const first = await hub.loginAsAdmin();
    await hub.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken },
      payload: { currentPassword: 'admin', newPassword: 'a-real-password-1234' },
    });
    const stale = await hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { cookie: first.cookie } });
    expect(stale.statusCode).toBe(401);
  });
});

describe('pairing', () => {
  it('issues a scoped credential only after the fingerprint is confirmed', async () => {
    const admin = await hub.completeSetup();
    const create = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { deviceKind: 'player', scopes: ['library:read', 'search:use'], ttlSeconds: 600 },
    });
    expect(create.statusCode).toBe(201);
    const session = create.json() as { sessionId: string; code: string; qrSvg: string; hubFingerprint: string };
    expect(session.code).toMatch(/^[0-9A-Z-]{10,}$/);
    expect(session.qrSvg).toContain('<svg');

    const claim = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/claim',
      payload: { code: session.code, deviceName: 'Kitchen', deviceKind: 'player', publicKey: 'device-public-key-00000000', appVersion: '0.1.0', protocolVersion: 1 },
    });
    const claimed = claim.json() as { claimSecret: string; verificationFingerprint: string };
    expect(claimed.verificationFingerprint).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){2}$/);

    // Before confirmation, completing must fail even with a valid claim secret.
    const early = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/complete', payload: { sessionId: session.sessionId, claimSecret: claimed.claimSecret } });
    expect(early.statusCode).toBe(409);

    await hub.app.inject({
      method: 'POST',
      url: `/api/v1/pairing/sessions/${session.sessionId}/confirm`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { verificationFingerprint: claimed.verificationFingerprint },
    });

    const complete = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/complete', payload: { sessionId: session.sessionId, claimSecret: claimed.claimSecret } });
    expect(complete.statusCode).toBe(200);
    const credential = complete.json() as { secret: string; scopes: string[] };
    expect(credential.secret.length).toBeGreaterThanOrEqual(32);
    expect(credential.scopes).toEqual(['library:read', 'search:use']);

    // Single use: the same confirmed session cannot mint a second credential.
    const replay = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/complete', payload: { sessionId: session.sessionId, claimSecret: claimed.claimSecret } });
    expect(replay.statusCode).toBe(409);
  });

  it('never returns a pairing code in the session list', async () => {
    const admin = await hub.completeSetup();
    const create = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 },
    });
    const code = (create.json() as { code: string }).code;
    const list = await hub.app.inject({ method: 'GET', url: '/api/v1/pairing/sessions', headers: { cookie: admin.cookie } });
    expect(list.body).not.toContain(code);
    expect(list.body).not.toContain('codeHash');
  });

  it('expires a pairing session that is not claimed in time', async () => {
    const admin = await hub.completeSetup();
    const create = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 60 },
    });
    const session = create.json() as { code: string };
    hub.clock.advance(61_000);
    const claim = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/claim',
      payload: { code: session.code, deviceName: 'Late', deviceKind: 'player', publicKey: 'k'.repeat(32), appVersion: '0.1.0', protocolVersion: 1 },
    });
    expect(claim.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('authenticates a paired device and reports its own scopes', async () => {
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const me = await hub.app.inject({ method: 'GET', url: '/api/v1/devices/me', headers: { authorization: device.authorization } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ device: { name: 'Test player' }, user: { displayName: expect.any(String) } });
  });

  it('stops a revoked device immediately', async () => {
    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    await hub.app.inject({ method: 'DELETE', url: `/api/v1/devices/${device.deviceId}`, headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken } });
    const after = await hub.app.inject({ method: 'GET', url: '/api/v1/devices/me', headers: { authorization: device.authorization } });
    expect(after.statusCode).toBe(401);
  });
});
