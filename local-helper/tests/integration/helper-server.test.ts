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
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
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

/** GitHub, faked: spotDL publishes a build (not a real program), nothing else answers. */
const githubCalls: string[] = [];
const SPOTDL_BYTES = Buffer.from('not really spotdl');
const fakeGitHub = (async (input: string | URL | Request) => {
  const url = String(input);
  githubCalls.push(url);
  if (url === 'https://api.github.com/repos/spotDL/spotify-downloader/releases/latest') {
    const names = ['spotdl-4.5.2-win32.exe', 'spotdl-4.5.2-linux', 'spotdl-4.5.2-darwin'];
    return Response.json({
      tag_name: 'v4.5.2',
      assets: names.map((name) => ({ name, size: SPOTDL_BYTES.length, browser_download_url: `https://github.com/spotDL/spotify-downloader/releases/download/v4.5.2/${name}`, digest: `sha256:${createHash('sha256').update(SPOTDL_BYTES).digest('hex')}` })),
    });
  }
  if (url.startsWith('https://github.com/spotDL/spotify-downloader/releases/download/')) return new Response(SPOTDL_BYTES);
  return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
}) as typeof fetch;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'np-helper-test-'));
  // A .mjs path is run with this Node, so the same stub works on Windows, where a script cannot be
  // executed by name without a shell.
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
    fetchImpl: fakeGitHub,
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
    // A missing tool carries the sentence that explains it rather than just a false: where a build
    // is published it is set up automatically; where none is, the one line that installs it.
    expect(health.tools.find((t) => t.id === 'spotdl')?.installHint).toMatch(/checks it against the published SHA-256|pipx install spotdl/);
    // Setup has not looked yet, so no setup state is claimed.
    expect(health.tools.find((t) => t.id === 'spotdl')?.setup).toBeUndefined();
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

  it('refuses a Host that is not this helper, which is what DNS rebinding looks like', async () => {
    // fetch will not let a test choose Host, so this goes through http directly.
    const port = Number(new URL(base).port);
    expect(await statusWithHost('evil.example', port, HELPER_ROUTES.health)).toBe(421);
    expect(await statusWithHost(`evil.example:${port}`, port, '/')).toBe(421);
    expect(await statusWithHost(`127.0.0.1:${port + 1}`, port, HELPER_ROUTES.health)).toBe(421);
    expect(await statusWithHost(`localhost:${port}`, port, HELPER_ROUTES.health)).toBe(200);
  });

  it('answers a badly escaped id with 400, not 500', async () => {
    expect((await call('/helper/v1/jobs/%E0%A4%A')).status).toBe(400);
    expect((await call('/helper/v1/jobs/%zz/files/x')).status).toBe(400);
  });

  it('refuses an install route for a tool it does not know', async () => {
    expect((await post('/helper/v1/tools/curl/install', {})).status).toBe(404);
  });
});

describe('setting tools up', () => {
  it('takes an install request for spotDL and FFmpeg too, and installs nothing it could not verify', async () => {
    // The fake GitHub publishes a spotDL build with the right digest; the bytes are not a program,
    // so the version check refuses them. FFmpeg's repository does not answer at all.
    githubCalls.length = 0;
    const spotdl = await post(HELPER_ROUTES.install('spotdl'), {});
    expect(spotdl.status).toBe(409);
    const spotdlResult = (await spotdl.json()) as { tool: string; installed: boolean; reason: string };
    expect(spotdlResult).toMatchObject({ tool: 'spotdl', installed: false });
    expect(spotdlResult.reason).toMatch(/would not report a version|no .*build|pipx/);

    const ffmpeg = await post(HELPER_ROUTES.install('ffmpeg'), {});
    expect(ffmpeg.status).toBe(409);
    expect(((await ffmpeg.json()) as { reason: string }).reason).toMatch(/GitHub did not answer|package manager/);
    // Only ever the fake GitHub.
    expect(githubCalls.every((url) => url.startsWith('https://api.github.com/') || url.startsWith('https://github.com/'))).toBe(true);
  });

  it('reports each tool’s setup state in health once setup has run', async () => {
    await helper.tools.ensure({ ignoreBackoff: true });
    const health = (await (await call(HELPER_ROUTES.health)).json()) as HelperHealth;
    // The configured yt-dlp is the person's own: ready, and never replaced.
    expect(health.tools.find((t) => t.id === 'yt-dlp')?.setup).toEqual({ state: 'ready' });
    const spotdl = health.tools.find((t) => t.id === 'spotdl')!;
    expect(spotdl.present).toBe(false);
    expect(['failed', 'unsupported']).toContain(spotdl.setup?.state);
    expect(spotdl.setup?.reason).toBeTruthy();
  });
});

function statusWithHost(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      res.resume();
      resolvePromise(res.statusCode ?? 0);
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

/** Poll until the job stops moving. The stub finishes in milliseconds; the cap is for when it does not. */
async function settle(id: string, attempts = 200): Promise<HelperJob> {
  for (let i = 0; i < attempts; i += 1) {
    const job = (await (await call(HELPER_ROUTES.job(id))).json()) as HelperJob;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} never finished`);
}
