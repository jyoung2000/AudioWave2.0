/**
 * The whole chain, over a real socket, with a stub standing in for yt-dlp.
 *
 * The stub is the point. Nothing here touches the network or a real site: it answers `--version`
 * like a tool does, reads the arguments the helper built, and writes a file where the helper said
 * to. That is exactly the contract between this program and yt-dlp, so testing against it tests the
 * thing that can actually break — the wiring — without making the test suite depend on a video
 * still existing somewhere.
 *
 * The refusals get the same treatment as the success, because a helper that runs subprocesses is
 * one where "it said no" is the behaviour most worth proving.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_ROUTES, type HelperHealth, type HelperJob } from '@now-playing/contracts';
import { startHelper, type Helper } from '../../src/server.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const ALLOWED_ORIGIN = 'https://player.example';

/** A stand-in for yt-dlp: reports a version, then writes what it was asked to write. */
const STUB = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2026.09.01\\n'); process.exit(0); }
const paths = args[args.indexOf('--paths') + 1];
if (!paths) { process.stderr.write('ERROR: no --paths\\n'); process.exit(1); }
const url = args[args.length - 1];
if (url.includes('fail')) { process.stderr.write('WARNING: ignore me\\nERROR: Video unavailable\\n'); process.exit(1); }
process.stdout.write('[download]  12.5% of 3.00MiB\\n');
process.stdout.write('[download] 100.0% of 3.00MiB\\n');
process.stdout.write('[ExtractAudio] Destination: out.m4a\\n');
writeFileSync(join(paths, 'A Song.m4a'), 'pretend audio');
process.exit(0);
`;

let helper: Helper;
let root: string;
let base: string;

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { ...init, headers: { 'x-helper-token': TOKEN, ...(init.headers ?? {}) } });
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

const owned = { basis: 'user-owned' as const, acknowledged: true as const };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-test-'));
  const stub = join(root, 'fake-yt-dlp.mjs');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  helper = await startHelper({
    // 0 lets the OS pick, so a busy machine cannot make this test flaky.
    port: 0,
    version: '1.0.0-test',
    token: TOKEN,
    workDir: join(root, 'work'),
    toolsDir: join(root, 'tools'),
    timeoutMs: 20_000,
    allowedHosts: ['www.youtube.com', 'music.youtube.com'],
    allowedOrigins: [ALLOWED_ORIGIN],
    app: null,
    configured: { 'yt-dlp': stub },
    log: () => {},
  });
  const address = helper.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await helper.close();
  rmSync(root, { recursive: true, force: true });
});

describe('what it says about itself', () => {
  it('reports the tool it was pointed at, and the ones it could not find', async () => {
    const health = (await (await call(HELPER_ROUTES.health)).json()) as HelperHealth;
    expect(health.helper).toBe('now-playing-local-helper');
    expect(health.servesApp).toBe(false);
    const ytDlp = health.tools.find((t) => t.id === 'yt-dlp');
    expect(ytDlp).toMatchObject({ present: true, origin: 'configured', version: '2026.09.01' });
    expect(health.tools.find((t) => t.id === 'spotdl')).toMatchObject({ present: false, origin: 'missing' });
    // A missing tool carries the sentence that fixes it rather than just a false.
    expect(health.tools.find((t) => t.id === 'spotdl')?.installHint).toMatch(/pipx install spotdl/);
  });

  it('never puts a path to anything on this machine in an answer', async () => {
    const body = await (await call(HELPER_ROUTES.health)).text();
    expect(body).not.toContain(root);
    expect(body).not.toContain('fake-yt-dlp');
  });

  it('answers health without a token, because the app has to find it before it has one', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.health}`);
    expect(response.status).toBe(200);
  });
});

describe('fetching', () => {
  it('runs the tool and hands back the file it produced', async () => {
    const created = await post(HELPER_ROUTES.fetch, { url: 'https://www.youtube.com/watch?v=abc', authorization: owned });
    expect(created.status).toBe(202);
    const job = (await created.json()) as HelperJob;
    expect(job.state).toBe('queued');
    expect(job.tool).toBe('yt-dlp');

    const done = await settle(job.id);
    expect(done.state).toBe('done');
    expect(done.files).toHaveLength(1);
    expect(done.files[0]!.name).toBe('A Song.m4a');
    expect(done.files[0]!.contentType).toBe('audio/mp4');
    // The percentage came from the tool's own progress lines, not from a guess.
    expect(done.percent).toBe(100);

    const file = await call(HELPER_ROUTES.file(done.id, done.files[0]!.id));
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('pretend audio');
    expect(file.headers.get('content-disposition')).toContain('A%20Song.m4a');
  });

  it('reports the tool’s own reason when it fails, without the warnings around it', async () => {
    const job = (await (await post(HELPER_ROUTES.fetch, { url: 'https://www.youtube.com/watch?v=fail', authorization: owned })).json()) as HelperJob;
    const done = await settle(job.id);
    expect(done.state).toBe('failed');
    expect(done.error).toBe('Video unavailable');
  });

  it('forgets a job on request, and its files with it', async () => {
    const job = (await (await post(HELPER_ROUTES.fetch, { url: 'https://music.youtube.com/watch?v=abc', authorization: owned })).json()) as HelperJob;
    const done = await settle(job.id);
    expect((await call(HELPER_ROUTES.job(done.id), { method: 'DELETE' })).status).toBe(200);
    expect((await call(HELPER_ROUTES.job(done.id))).status).toBe(404);
    expect((await call(HELPER_ROUTES.file(done.id, done.files[0]!.id))).status).toBe(404);
  });
});

describe('what it refuses', () => {
  it('refuses a host it was not told about', async () => {
    const response = await post(HELPER_ROUTES.fetch, { url: 'https://evil.example/track', authorization: owned });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/allowlist/i);
  });

  it('refuses an address on this network', async () => {
    // The one that matters most: the helper is inside somebody's firewall.
    const response = await post(HELPER_ROUTES.fetch, { url: 'https://192.168.0.5/track', authorization: owned });
    expect(response.status).toBe(400);
  });

  it('refuses a request with no rights basis', async () => {
    expect((await post(HELPER_ROUTES.fetch, { url: 'https://www.youtube.com/watch?v=abc' })).status).toBe(400);
    expect((await post(HELPER_ROUTES.fetch, { url: 'https://www.youtube.com/watch?v=abc', authorization: { basis: 'user-owned', acknowledged: false } })).status).toBe(400);
  });

  it('refuses a body that is not JSON, because that is what forces the preflight', async () => {
    const response = await call(HELPER_ROUTES.fetch, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(response.status).toBe(415);
  });

  it('refuses an origin it does not know, before anything else', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.health}`, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  it('answers an origin it was told about, and says so in the headers', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.health}`, { headers: { origin: ALLOWED_ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('agrees to the private-network preflight only when asked, for an origin it allows', async () => {
    const response = await fetch(`${base}${HELPER_ROUTES.fetch}`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-private-network')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')).toContain('x-helper-token');

    const plain = await fetch(`${base}${HELPER_ROUTES.fetch}`, { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' } });
    expect(plain.headers.get('access-control-allow-private-network')).toBeNull();
  });

  it('refuses to install anything but yt-dlp, and says why', async () => {
    const response = await post(HELPER_ROUTES.install('spotdl'), {});
    expect(response.status).toBe(409);
    expect(((await response.json()) as { reason: string }).reason).toMatch(/does not fetch spotdl/);
  });
});

/** Poll until the job stops moving. The stub finishes in milliseconds; the cap is for when it does not. */
async function settle(id: string, attempts = 200): Promise<HelperJob> {
  for (let i = 0; i < attempts; i += 1) {
    const job = (await (await call(HELPER_ROUTES.job(id))).json()) as HelperJob;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} never finished`);
}
