/**
 * `X-Forwarded-For` is believed only from an address the operator listed.
 *
 * Behind a reverse proxy every request arrives from the proxy, so without this the per-IP rate
 * limits collapse into one shared bucket — one noisy client locks everyone out, and every audit
 * entry records the proxy's address instead of the caller's.
 *
 * The fix is not "trust the header": a header anyone can send is not evidence. It is believed only
 * when the connection itself comes from `NP_TRUSTED_PROXY_CIDRS`, which is empty by default, so a
 * hub exposed directly to the internet cannot be told by a caller which IP to rate-limit and audit
 * it as. These tests assert both halves — that it works when configured, and that it does nothing
 * when it is not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';

const ATTEMPTS = 4;

let hub: TestHub | null = null;

afterEach(async () => {
  await hub?.dispose();
  hub = null;
});

async function hubWithProxies(trustedProxyCidrs: string[]): Promise<TestHub> {
  // A tight auth limit so a handful of requests reaches it, and full IPs so the audit trail can be
  // compared against what was sent rather than against a truncation of it.
  hub = await createTestHub({ config: { trustedProxyCidrs, ipLogging: 'full' }, deps: { rateLimits: { auth: ATTEMPTS } } });
  return hub;
}

/** A failed login: rate-limited as `auth`, and audited with the address the hub believes. */
async function login(app: TestHub['app'], forwardedFor: string): Promise<number> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': forwardedFor }, payload: { username: 'admin', password: 'wrong-password' } });
  return response.statusCode;
}

describe('trusted proxies', () => {
  it('keeps one client from exhausting another client\u2019s allowance when a proxy is trusted', async () => {
    // `inject` presents every request as coming from 127.0.0.1, so that is the "proxy" here.
    const app = (await hubWithProxies(['127.0.0.1/32'])).app;
    for (let i = 0; i < ATTEMPTS; i += 1) await login(app, '203.0.113.9');
    expect(await login(app, '203.0.113.9')).toBe(429);
    // A different client behind the same proxy has its own bucket.
    expect(await login(app, '198.51.100.7')).not.toBe(429);
  });

  it('ignores the header when no proxy is trusted, so nobody can pick their own bucket', async () => {
    const app = (await hubWithProxies([])).app;
    for (let i = 0; i < ATTEMPTS; i += 1) await login(app, '203.0.113.9');
    // Same connection, different claimed client: still the same bucket, because the claim is not
    // evidence. Rotating the header must not be a way around the limit.
    expect(await login(app, '198.51.100.7')).toBe(429);
  });

  it('ignores the header when the caller is outside the listed range', async () => {
    const app = (await hubWithProxies(['10.4.0.0/16'])).app;
    for (let i = 0; i < ATTEMPTS; i += 1) await login(app, '203.0.113.9');
    expect(await login(app, '198.51.100.7')).toBe(429);
  });

  it('audits the forwarded client address only when the proxy is trusted', async () => {
    const trusted = await hubWithProxies(['127.0.0.1/32']);
    await login(trusted.app, '203.0.113.9');
    const trustedIps = trusted.ctx.repos.audit.list({ limit: 20 }).map((e) => e.ipDisplay);
    expect(trustedIps).toContain('203.0.113.9');
    await trusted.dispose();

    const untrusted = await hubWithProxies([]);
    await login(untrusted.app, '203.0.113.9');
    const untrustedIps = untrusted.ctx.repos.audit.list({ limit: 20 }).map((e) => e.ipDisplay);
    expect(untrustedIps).not.toContain('203.0.113.9');
  });
});
