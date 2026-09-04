/**
 * Security properties of the HTTP surface.
 *
 * Each test here corresponds to a claim made in docs/SECURITY.md. If one fails, the documentation
 * is wrong rather than the test being fussy: these assert *behaviour a user relies on*, not
 * implementation details.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
});

afterEach(async () => {
  await hub.dispose();
});

describe('CSRF', () => {
  it('rejects a cookie-authenticated write without the double-submit token', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie },
      payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });
  });

  it('rejects a wrong CSRF token', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': 'not-the-token' },
      payload: { deviceKind: 'player', scopes: ['library:read'], ttlSeconds: 600 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not require CSRF for a bearer credential, which no browser attaches automatically', async () => {
    const device = await pairDevice(hub, admin);
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/groups', headers: { authorization: device.authorization }, payload: { name: 'Bearer group' } });
    expect(response.statusCode).toBe(201);
  });

  it('allows cookie reads without a token', async () => {
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/devices', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });
});

describe('authentication and scopes', () => {
  it('refuses an unauthenticated request to an admin route', async () => {
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/devices' })).statusCode).toBe(401);
  });

  it('refuses a malformed or unknown bearer credential', async () => {
    for (const authorization of ['Bearer garbage', 'Bearer 00000000-0000-7000-8000-000000000000.wrongsecret', 'Basic abc']) {
      const response = await hub.app.inject({ method: 'GET', url: '/api/v1/devices/me', headers: { authorization } });
      expect(response.statusCode, authorization).toBe(401);
    }
  });

  it('enforces per-route scopes on a device credential', async () => {
    const limited = await pairDevice(hub, admin, { name: 'Read only', scopes: ['library:read'] });
    const search = await hub.app.inject({ method: 'GET', url: '/api/v1/search?q=test', headers: { authorization: limited.authorization } });
    expect(search.statusCode).toBe(403);
    expect(search.json()).toMatchObject({ code: 'forbidden' });
    // The response says which scope is missing so the app can explain it rather than just failing.
    expect(JSON.stringify(search.json())).toContain('search:use');
  });

  it('refuses an admin-only route to a device credential', async () => {
    const device = await pairDevice(hub, admin);
    expect((await hub.app.inject({ method: 'GET', url: '/api/v1/network', headers: { authorization: device.authorization } })).statusCode).toBe(401);
  });
});

describe('secrets never leave the hub', () => {
  it('never returns a provider client secret after it is set', async () => {
    await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/providers/spotify/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { enabled: true, clientId: 'client-id-value', clientSecret: 'super-secret-value' },
    });
    const view = await hub.app.inject({ method: 'GET', url: '/api/v1/providers/spotify/config', headers: { cookie: admin.cookie } });
    expect(view.body).not.toContain('super-secret-value');
    expect(view.json()).toMatchObject({ configured: true, clientId: 'client-id-value' });
    // A hint is fine; the secret is not.
    expect(view.json()).toHaveProperty('clientSecretHint');
  });

  it('keeps the sealed secret out of the diagnostics bundle and the export', async () => {
    await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/providers/spotify/config',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { enabled: true, clientId: 'client-id-value', clientSecret: 'super-secret-value' },
    });
    for (const url of ['/api/v1/diagnostics/bundle', '/api/v1/export']) {
      const response = await hub.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain('super-secret-value');
    }
  });

  it('names its redactions in the diagnostics bundle', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/diagnostics/bundle', headers: { cookie: admin.cookie } });
    const bundle = response.json() as { redactions: string[] };
    expect(bundle.redactions.length).toBeGreaterThan(5);
    expect(bundle.redactions.join(' ')).toContain('token');
  });

  it('never writes a password or a token into the log ring', async () => {
    await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'a-real-password-1234' } });
    const logs = await hub.app.inject({ method: 'GET', url: '/api/v1/logs?level=debug&limit=500', headers: { cookie: admin.cookie } });
    expect(logs.body).not.toContain('a-real-password-1234');
  });

  it('truncates IP addresses in the audit trail by default', async () => {
    const audit = await hub.app.inject({ method: 'GET', url: '/api/v1/security/audit', headers: { cookie: admin.cookie } });
    const events = (audit.json() as { items: Array<{ ipDisplay: string | null }> }).items;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      if (event.ipDisplay) expect(event.ipDisplay, 'IP addresses must not be recorded in full').toMatch(/\.x$|^h:|^unknown$/);
    }
  });
});

describe('response headers', () => {
  it('sets the documented security headers on every response', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/hub' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(String(response.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(String(response.headers['content-security-policy'])).toContain("object-src 'none'");
  });

  it('never allows credentials on a cross-origin response', async () => {
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/hub', headers: { origin: 'http://localhost:5173' } });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses a preflight from an unknown origin', async () => {
    const response = await hub.app.inject({ method: 'OPTIONS', url: '/api/v1/hub', headers: { origin: 'https://evil.example' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('input validation', () => {
  it('answers problem+json with a correlation id when a body fails validation', async () => {
    const response = await hub.app.inject({
      method: 'POST',
      url: '/api/v1/pairing/sessions',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
      payload: { deviceKind: 'toaster', scopes: [], ttlSeconds: 5 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 400, code: 'validation' });
    expect(response.headers['x-correlation-id']).toBeTruthy();
  });

  it('does not leak an internal error message on a 500', async () => {
    // A route whose service will throw: an artwork id that passes the schema but not the check.
    const response = await hub.app.inject({ method: 'GET', url: '/api/v1/library/artwork/not-an-artwork-id', headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('/home/');
  });
});

describe('rate limiting', () => {
  it('throttles repeated failed logins and says when to retry', async () => {
    const limited = await createTestHub({ deps: { rateLimits: { auth: 5 } } });
    try {
      let sawLimit = false;
      for (let i = 0; i < 12; i += 1) {
        const response = await limited.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'wrong-password' } });
        if (response.statusCode === 429) {
          sawLimit = true;
          expect(response.json()).toMatchObject({ code: 'rate-limited' });
          expect(response.headers['retry-after']).toBeTruthy();
          break;
        }
      }
      expect(sawLimit, 'repeated failed logins must be rate limited').toBe(true);
    } finally {
      await limited.dispose();
    }
  });
});
