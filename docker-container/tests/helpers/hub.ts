/**
 * Test harness: a real hub, with fake edges.
 *
 * Every test in this directory builds the actual application — real Fastify, real SQLite, real
 * routes, real services — and replaces only what would otherwise make tests slow, flaky or
 * network-dependent: the clock, the random source, outbound fetch, DNS and FFmpeg discovery.
 * Nothing is mocked at module level, so a test failing here means the hub is genuinely broken
 * rather than a stub having drifted.
 *
 * Password hashing is dialled down to argon2id's minimum cost — the algorithm and the code path
 * are identical, only the work factor differs, so login stays a millisecond instead of a second.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type HubApp } from '../../src/app.js';
import type { HubConfig } from '../../src/config.js';
import type { Clock, FfmpegInfo, HubDeps, RandomSource } from '../../src/deps.js';

export interface TestClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock the test moves by hand, so nothing depends on wall-clock timing. */
export function testClock(startMs = Date.parse('2026-01-01T00:00:00.000Z')): TestClock {
  let now = startMs;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
  };
}

/**
 * Deterministic bytes. Every value the hub derives from randomness (session ids, pairing codes,
 * share tokens, credential secrets) becomes reproducible, which is what lets a test assert on a
 * *specific* generated value rather than a shape.
 */
export function seededRandom(seed = 1): RandomSource {
  let state = seed >>> 0 || 1;
  return {
    bytes(length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        out[i] = state & 0xff;
      }
      return out;
    },
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FakeFetch {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
  /** Answer the next request whose URL contains `match`. */
  on(match: string, respond: () => { status?: number; body?: unknown; headers?: Record<string, string> }): void;
}

/**
 * Outbound HTTP the test controls. An unregistered URL fails loudly rather than reaching the
 * network — a test that accidentally calls a real provider is a bug, not a slow test.
 */
export function fakeFetch(): FakeFetch {
  const handlers: Array<{ match: string; respond: () => { status?: number; body?: unknown; headers?: Record<string, string> } }> = [];
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : null });
    const handler = handlers.find((h) => url.includes(h.match));
    if (!handler) throw new Error(`No fake response registered for ${url}. Register one with fetch.on(...) or the test is reaching the real network.`);
    const result = handler.respond();
    const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {});
    return new Response(body, { status: result.status ?? 200, headers: { 'content-type': 'application/json', ...(result.headers ?? {}) } });
  }) as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    calls,
    on(match, respond) {
      handlers.push({ match, respond });
    },
  };
}

export interface TestHub extends HubApp {
  dataDir: string;
  clock: TestClock;
  fetch: FakeFetch;
  /** Log in as the bootstrap admin and return the cookie + CSRF token for later calls. */
  loginAsAdmin(password?: string): Promise<{ cookie: string; csrfToken: string }>;
  /** Complete first-run setup so the setup-gated routes become reachable. */
  completeSetup(newPassword?: string): Promise<{ cookie: string; csrfToken: string }>;
  dispose(): Promise<void>;
}

export interface TestHubOptions {
  config?: Partial<HubConfig>;
  deps?: Partial<HubDeps>;
  ffmpeg?: FfmpegInfo;
  clock?: TestClock;
}

export const NO_FFMPEG: FfmpegInfo = { available: false, path: null, version: null, encoders: [] };
export const FULL_FFMPEG: FfmpegInfo = { available: true, path: '/usr/bin/ffmpeg', version: '7.1', encoders: ['libmp3lame', 'aac', 'libopus', 'flac'] };

export async function createTestHub(options: TestHubOptions = {}): Promise<TestHub> {
  const dataDir = mkdtempSync(join(tmpdir(), 'np-hub-test-'));
  const clock = options.clock ?? testClock();
  const fetch = fakeFetch();
  const config: HubConfig = {
    dataDir,
    port: 0,
    bindMode: 'localhost',
    bindAddress: null,
    publicEndpoint: null,
    trustedProxyCidrs: [],
    logLevel: 'silent',
    discordToken: null,
    installKeyFile: join(dataDir, 'install.key'),
    ipLogging: 'truncated',
    ffmpegPath: null,
    publicDomainDir: null,
    demoMode: false,
    nodeEnv: 'test',
    ...options.config,
  };

  const hub = await buildApp({
    config,
    clock,
    random: seededRandom(),
    fetch: fetch.fetch,
    // No DNS in tests: every hostname resolves to a public address so the SSRF guard's *other*
    // checks (scheme, allowlist, redirects) are what the tests exercise.
    dnsLookup: async () => ['93.184.216.34'],
    ffmpegLocator: async () => options.ffmpeg ?? NO_FFMPEG,
    passwordHashing: { memoryCost: 8, timeCost: 1, parallelism: 1 },
    // Generous limits: these tests exercise flows, not throttling. The security tests set their own.
    rateLimits: { default: 100_000, auth: 100_000, pairing: 100_000, search: 100_000, write: 100_000 },
    disableBackgroundJobs: true,
    logDestination: 'silent',
    ...options.deps,
  });

  await hub.start();

  const login = async (password: string): Promise<{ cookie: string; csrfToken: string }> => {
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password } });
    if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    return { cookie, csrfToken: (response.json() as { csrfToken: string }).csrfToken };
  };

  return {
    ...hub,
    dataDir,
    clock,
    fetch,
    loginAsAdmin: (password = 'admin') => login(password),
    async completeSetup(newPassword = 'a-real-password-1234') {
      const first = await login('admin');
      const response = await hub.app.inject({
        method: 'POST',
        url: '/api/v1/auth/change-password',
        headers: { cookie: first.cookie, 'x-csrf-token': first.csrfToken },
        payload: { currentPassword: 'admin', newPassword },
      });
      if (response.statusCode !== 200) throw new Error(`Password change failed: ${response.statusCode} ${response.body}`);
      const setCookie = response.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
      return { cookie, csrfToken: (response.json() as { csrfToken: string }).csrfToken };
    },
    async dispose() {
      await hub.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Pair a device end to end and return its bearer credential. */
export async function pairDevice(
  hub: TestHub,
  admin: { cookie: string; csrfToken: string },
  options: { name?: string; kind?: 'player' | 'companion'; scopes?: string[] } = {},
): Promise<{ deviceId: string; authorization: string; scopes: string[] }> {
  const create = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/pairing/sessions',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { deviceKind: options.kind ?? 'player', scopes: options.scopes ?? ['library:read', 'search:use', 'group:member', 'history:events', 'shares:create', 'transfers:receive', 'downloads:request', 'library:share'], ttlSeconds: 600 },
  });
  if (create.statusCode !== 201) throw new Error(`Pairing create failed: ${create.statusCode} ${create.body}`);
  const session = create.json() as { sessionId: string; code: string };

  const claim = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/pairing/claim',
    payload: { code: session.code, deviceName: options.name ?? 'Test player', deviceKind: options.kind ?? 'player', publicKey: 'test-public-key-000000000000', appVersion: '0.1.0', protocolVersion: 1 },
  });
  if (claim.statusCode !== 200) throw new Error(`Pairing claim failed: ${claim.statusCode} ${claim.body}`);
  const claimed = claim.json() as { claimSecret: string; verificationFingerprint: string };

  const confirm = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/pairing/sessions/${session.sessionId}/confirm`,
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken },
    payload: { verificationFingerprint: claimed.verificationFingerprint },
  });
  if (confirm.statusCode !== 200) throw new Error(`Pairing confirm failed: ${confirm.statusCode} ${confirm.body}`);

  const complete = await hub.app.inject({ method: 'POST', url: '/api/v1/pairing/complete', payload: { sessionId: session.sessionId, claimSecret: claimed.claimSecret } });
  if (complete.statusCode !== 200) throw new Error(`Pairing complete failed: ${complete.statusCode} ${complete.body}`);
  const credential = complete.json() as { deviceId: string; credentialId: string; secret: string; scopes: string[] };
  return { deviceId: credential.deviceId, authorization: `Bearer ${credential.credentialId}.${credential.secret}`, scopes: credential.scopes };
}
