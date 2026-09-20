/**
 * DNS-rebinding and cross-origin defences: the Host allowlist, Origin checks on login and admin
 * writes, constant-time CSRF comparison, malformed cookies, per-address pairing lockout and the
 * WebSocket subprotocol selection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCookies, safeEqual } from '../../src/api/register.js';
import { selectSubprotocol, WS_SUBPROTOCOL } from '../../src/realtime/server.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const PASSWORD = 'a-real-password-1234';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup(PASSWORD);
});

afterEach(async () => {
  await hub.dispose();
});

describe('Host allowlist', () => {
  it('rejects a request addressed to an unknown host name', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/hub', headers: { host: 'attacker.example:8787' } });
    expect(response.statusCode).toBe(421);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('refuses an admin session presented under a rebinding host', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { host: 'rebind.attacker.example', cookie: admin.cookie } });
    expect(response.statusCode).toBe(421);
  });

  it('accepts loopback names, IP literals and single-label LAN names', async () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', '192.168.1.20:8787', '10.0.0.5', 'nowplaying:8787']) {
      const response = await hub.app.inject({ method: 'GET', url: '/api/v1/hub', headers: { host } });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it('accepts the configured public endpoint', async () => {
    hub.ctx.network.update({ publicEndpoint: 'https://music.example.org' });
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/hub', headers: { host: 'music.example.org' } });
    expect(response.statusCode).toBe(200);
  });

  it('lets a valid device credential through under any host name, but not an invalid one', async () => {
    const device = await pairDevice(hub, admin);
    const ok = await hub.app.inject({ method: 'GET', url: '/api/v1/groups', headers: { host: 'desktop.home.arpa:8787', authorization: device.authorization } });
    expect(ok.statusCode).toBe(200);
    const forged = await hub.app.inject({ method: 'GET', url: '/api/v1/hub', headers: { host: 'attacker.example', authorization: 'Bearer 00000000-0000-7000-8000-000000000000.aaaaaaaaaaaaaaaaaaaaaaaa' } });
    expect(forged.statusCode).toBe(421);
  });
});

describe('Origin checks', () => {
  it('refuses a cross-origin login', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://attacker.example' }, payload: { username: 'admin', password: PASSWORD } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a login marked cross-site by the browser even without Origin', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'sec-fetch-site': 'cross-site' }, payload: { username: 'admin', password: PASSWORD } });
    expect(response.statusCode).toBe(403);
  });

  it('allows a same-origin login', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: 'localhost:8787', origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin' }, payload: { username: 'admin', password: PASSWORD } });
    expect(response.statusCode).toBe(200);
  });

  it('refuses an admin write from another origin even with the right CSRF token', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, origin: 'http://attacker.example', 'sec-fetch-site': 'same-origin' },
      payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses an opaque (null) origin', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'null' }, payload: { username: 'admin', password: PASSWORD } });
    expect(response.statusCode).toBe(403);
  });
});

describe('CSRF token and cookie parsing', () => {
  it('compares tokens without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('rejects a CSRF token of the wrong length with 403, not 500', async () => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/sessions', headers: { cookie: admin.cookie, 'x-csrf-token': `${admin.csrfToken}x` }, payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 } });
    expect(response.statusCode).toBe(403);
  });

  it('treats a malformed cookie as absent instead of failing the request', async () => {
    expect(parseCookies('bad=%E0%A4%A; ok=1')).toEqual({ ok: '1' });
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: 'bad=%E0%A4%A' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: false });
  });
});

describe('pairing lockout', () => {
  it('locks out an address after repeated wrong codes without cancelling pending sessions', async () => {
    const create = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/sessions', headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken }, payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 } });
    expect(create.statusCode).toBe(201);
    const { sessionId, code } = create.json() as { sessionId: string; code: string };
    const wrong = { code: 'AAAAA-AAAAA', deviceName: 'Guesser', deviceKind: 'player', publicKey: 'test-public-key-000000000000', appVersion: '0.1.0', protocolVersion: 1 };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/claim', payload: wrong })).statusCode);
    expect(statuses.slice(0, 10).every((s) => s === 403 || s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // The legitimate session is still pending and claimable from another address.
    expect(hub.ctx.repos.pairing.find(sessionId)?.state).toBe('pending');
    const claim = await hub.ctx.pairing.claim({ code, deviceName: 'Real', deviceKind: 'player', publicKey: 'test-public-key-000000000000', appVersion: '0.1.0', protocolVersion: 1, platform: null }, { ip: '192.0.2.10', userAgent: null, correlationId: 'test' });
    expect(claim.sessionId).toBe(sessionId);
  });
});

describe('WebSocket subprotocol', () => {
  it('selects the protocol version and never the auth token', () => {
    expect(selectSubprotocol(new Set(['np-auth-00000000-0000-7000-8000-000000000000.secretsecretsecret', WS_SUBPROTOCOL]))).toBe(WS_SUBPROTOCOL);
    expect(selectSubprotocol(new Set(['np-auth-x.y']))).toBe(false);
  });
});
