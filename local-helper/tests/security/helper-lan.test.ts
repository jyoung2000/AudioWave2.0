/**
 * “Use the helper without pairing on this network” (companion Settings ▸ Network), in both states.
 *
 * Off — the default — the helper is not reachable from another device at all: it is bound to
 * loopback. On, another device reaches exactly the four token-free read routes (health, radio
 * now-playing, Live TV channels and guide), from a page on this network or from no page, with a
 * `Host` that names this PC. Everything else is refused from the network whatever is sent — the
 * token included — and this PC itself keeps every rule it had.
 *
 * The "other device" is this machine reaching itself on its own network address, which is what a
 * phone on the Wi-Fi looks like to the socket: not loopback.
 */
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HELPER_ROUTES } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';
import { LAN_READ_ROUTES, isLoopbackAddress, isPrivateIpv4, lanHostAllowed, lanPageAllowed } from '../../src/security.js';

const TOKEN = 'lan-test-token-lan-test-token-lan';
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;

interface Answer {
  status: number;
  body: string;
}

function ask(host: string, port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const roots: string[] = [];
const helpers: Helper[] = [];

async function start(lan: boolean): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'np-helper-lan-'));
  roots.push(root);
  const helper = await startHelper({
    port: 0,
    version: '1.0.0-test',
    token: TOKEN,
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 5_000,
    allowedHosts: ['www.youtube.com'],
    allowedOrigins: [],
    loopbackPages: true,
    app: null,
    configured: {},
    log: () => {},
    lan,
    tv: { channels: () => [], guide: () => [] },
    stationTitle: async () => ({ raw: 'A - B', artist: 'A', title: 'B', station: null, reason: null }),
  });
  helpers.push(helper);
  const address = helper.server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

afterAll(async () => {
  for (const helper of helpers) await helper.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the rules, on their own', () => {
  it('knows loopback from another device, however Node spells it', () => {
    for (const address of ['127.0.0.1', '127.4.5.6', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ['192.168.1.20', '::ffff:192.168.1.20', '10.0.0.2', 'fe80::1', undefined]) expect(isLoopbackAddress(address)).toBe(false);
  });

  it('takes a page on this network only by its private address, never by a name or a public address', () => {
    for (const origin of ['http://192.168.1.10:4546', 'https://10.0.0.5', 'http://172.16.0.9:8080', 'http://169.254.10.1']) expect(lanPageAllowed(origin)).toBe(true);
    for (const origin of ['http://nas.local:4546', 'https://evil.example', 'http://8.8.8.8', 'http://172.32.0.1', 'null', 'file://', 'http://192.168.1.10:4546/path', undefined]) expect(lanPageAllowed(origin)).toBe(false);
    expect(isPrivateIpv4('192.168.300.1')).toBe(false);
  });

  it('answers a Host that names this PC’s own address and port, and no other', () => {
    expect(lanHostAllowed('192.168.1.5:17342', 17342, ['192.168.1.5'])).toBe(true);
    expect(lanHostAllowed('evil.example:17342', 17342, ['192.168.1.5'])).toBe(false);
    expect(lanHostAllowed('192.168.1.5:17343', 17342, ['192.168.1.5'])).toBe(false);
    expect(lanHostAllowed(undefined, 17342, ['192.168.1.5'])).toBe(false);
  });

  it('lists only the four token-free reads', () => {
    expect([...LAN_READ_ROUTES].sort()).toEqual([HELPER_ROUTES.health, HELPER_ROUTES.radioNowPlaying, HELPER_ROUTES.tvChannels, HELPER_ROUTES.tvGuide].sort());
  });
});

describe.skipIf(!lanAddress)('with the setting off (the default)', () => {
  let port: number;
  beforeAll(async () => {
    port = await start(false);
  });

  it('cannot be reached from the network at all', async () => {
    await expect(ask(lanAddress!, port, HELPER_ROUTES.health, { headers: { host: `${lanAddress}:${port}` } })).rejects.toThrow(/ECONNREFUSED|EADDRNOTAVAIL|ECONNRESET/);
  });

  it('still answers this PC', async () => {
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.health)).status).toBe(200);
  });
});

describe.skipIf(!lanAddress)('with the setting on', () => {
  let port: number;
  const lanHost = () => ({ host: `${lanAddress}:${port}` });
  beforeAll(async () => {
    port = await start(true);
  });

  it('gives another device the four read routes, from no page or from a page on this network', async () => {
    expect((await ask(lanAddress!, port, HELPER_ROUTES.health, { headers: lanHost() })).status).toBe(200);
    const page = { ...lanHost(), origin: 'http://192.168.1.10:4546' };
    expect((await ask(lanAddress!, port, HELPER_ROUTES.tvChannels, { headers: page })).status).toBe(200);
    expect((await ask(lanAddress!, port, HELPER_ROUTES.tvGuide, { headers: page })).status).toBe(200);
    expect((await ask(lanAddress!, port, `${HELPER_ROUTES.radioNowPlaying}?url=${encodeURIComponent('https://radio.example.com/live')}`, { headers: page })).status).toBe(200);
  });

  it('keeps the radio and TV routes’ own rule: no page and no token is not enough', async () => {
    expect((await ask(lanAddress!, port, HELPER_ROUTES.tvChannels, { headers: lanHost() })).status).toBe(403);
  });

  it('refuses every other route from the network, even with the token', async () => {
    const withToken = { ...lanHost(), 'x-helper-token': TOKEN, 'content-type': 'application/json' };
    const fetchBody = JSON.stringify({ url: 'https://www.youtube.com/watch?v=a', authorization: { basis: 'own-content', acknowledged: true } });
    const attempts: Array<[string, string, string | undefined]> = [
      ['POST', HELPER_ROUTES.fetch, fetchBody],
      ['GET', HELPER_ROUTES.backupEstimate, undefined],
      ['POST', HELPER_ROUTES.install('yt-dlp'), '{}'],
      ['GET', HELPER_ROUTES.job('x'), undefined],
      ['DELETE', HELPER_ROUTES.job('x'), undefined],
      ['GET', '/', undefined],
      // Reading a link starts a tool on this PC, so it stays this PC's (NP-FIND-002).
      ['GET', `${HELPER_ROUTES.resolve}?url=${encodeURIComponent('https://www.youtube.com/watch?v=a')}`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const answer = await ask(lanAddress!, port, path, { method, headers: withToken, ...(body ? { body } : {}) });
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.body).toMatch(/Only this PC/);
    }
    // A write to a read route is refused too.
    expect((await ask(lanAddress!, port, HELPER_ROUTES.health, { method: 'POST', headers: withToken, body: '{}' })).status).toBe(403);
  });

  it('refuses a rebound name and a page from the internet', async () => {
    expect((await ask(lanAddress!, port, HELPER_ROUTES.health, { headers: { host: `evil.example:${port}` } })).status).toBe(421);
    expect((await ask(lanAddress!, port, HELPER_ROUTES.tvChannels, { headers: { ...lanHost(), origin: 'https://evil.example' } })).status).toBe(403);
    expect((await ask(lanAddress!, port, HELPER_ROUTES.tvChannels, { headers: { ...lanHost(), origin: 'http://nas.local:4546' } })).status).toBe(403);
  });

  it('keeps every rule it had for this PC', async () => {
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.health)).status).toBe(200);
    // A token is still needed for anything that does something.
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.backupEstimate)).status).toBe(401);
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.backupEstimate, { headers: { 'x-helper-token': TOKEN } })).status).toBe(200);
    // And a page on this network is no more than any other page to the routes only this PC may use.
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.health, { headers: { origin: 'http://192.168.1.10:4546' } })).status).toBe(403);
    expect((await ask('127.0.0.1', port, HELPER_ROUTES.health, { headers: { host: `evil.example:${port}` } })).status).toBe(421);
  });
});
