#!/usr/bin/env node
/**
 * Drives a hub through its own HTTP API, the way the brief allows ("through the hub's own UI/API").
 * Keeps the admin password and CSRF token in the scratch folder, never in the report.
 *
 *   node .agents/evidence/harness/hub-api.mjs --hub http://127.0.0.1:4550 setup      # first-run password change
 *   node .agents/evidence/harness/hub-api.mjs --hub http://127.0.0.1:4550 providers  # Music > Providers, as JSON
 *   node .agents/evidence/harness/hub-api.mjs --hub http://127.0.0.1:4550 download <url> "<title>" "<artist>"
 *
 * Secrets land in $NP_SCRATCH/hub-secrets.json, chmod-free but out of the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
if (!SCRATCH) {
  console.error('NP_SCRATCH must be set');
  process.exit(2);
}
const SECRETS = join(SCRATCH, 'hub-secrets.json');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const HUB = arg('hub', 'http://127.0.0.1:4550').replace(/\/$/, '');
const cmd = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))[0] ?? 'providers';
/** Positional arguments after the command name, ignoring --flags and their values. */
const positionals = argv.slice(argv.indexOf(cmd) + 1).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  const prev = all[i - 1];
  return !(prev && prev.startsWith('--') && all.indexOf(prev) < argv.indexOf(cmd));
});
const positional = (n) => positionals[n];
/**
 * The hub password is a secret: it is written to $NP_SCRATCH/hub-secrets.json by `setup` and read
 * back here, so no credential is ever committed. It never appears in a log line or a report.
 */
function loadSecrets() {
  return existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {};
}
/** Long and wordy enough to pass the hub's own weak-password denylist. */
function generatePassword() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}
let PASSWORD = loadSecrets().password;
if (!PASSWORD && cmd === 'setup') PASSWORD = generatePassword();
if (!PASSWORD) {
  console.error(`No password in ${SECRETS}. Run this script's "setup" command first.`);
  process.exit(2);
}
function saveSecrets(s) {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(SECRETS, JSON.stringify(s, null, 2));
  console.error(`secrets written to ${SECRETS} (not in the repository)`);
}

async function login(username = 'admin') {
  const r = await fetch(`${HUB}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (r.status !== 200) throw new Error(`login ${r.status}: ${await r.text()}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const { csrfToken } = await r.json();
  return { cookie, csrfToken };
}

/** Everything admin-authenticated needs: the session cookie plus x-csrf-token. */
async function asAdmin(fn) {
  const { cookie, csrfToken } = await login();
  return fn({
    cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
  });
}

async function setup() {
  // The first-run gate: the bootstrap password `admin` must be replaced.
  const boot = await fetch(`${HUB}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  if (boot.status !== 200) {
    console.log(`bootstrap password already refused (${boot.status}) - password is set`);
  } else {
    const cookie = boot.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const { csrfToken } = await boot.json();
    const r = await fetch(`${HUB}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ currentPassword: 'admin', newPassword: PASSWORD }),
    });
    console.log(`password change: ${r.status} ${r.ok ? '' : await r.text()}`);
    if (!r.ok) return 1;
  }
  const s = loadSecrets();
  s.hub = HUB;
  s.password = PASSWORD;
  saveSecrets(s);
  const check = await fetch(`${HUB}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  console.log(`sign-in with the new password: ${check.status}`);
  return check.status === 200 ? 0 : 1;
}

async function providers() {
  return asAdmin(async ({ cookie, headers }) => {
    const r = await fetch(`${HUB}/api/v1/providers`, { headers: { ...headers, cookie } });
    console.log(`GET /api/v1/providers -> ${r.status}`);
    console.log(JSON.stringify(await r.json(), null, 2));
    return r.ok ? 0 : 1;
  });
}

async function providerTest(name) {
  return asAdmin(async ({ cookie, headers }) => {
    const r = await fetch(`${HUB}/api/v1/providers/${encodeURIComponent(name)}/test`, {
      method: 'POST',
      headers: { ...headers, cookie },
    });
    console.log(`POST /api/v1/providers/${name}/test -> ${r.status}`);
    console.log(JSON.stringify(await r.json(), null, 2));
    return r.ok ? 0 : 1;
  });
}

async function download(url, title, artist) {
  return asAdmin(async ({ cookie, headers }) => {
    const r = await fetch(`${HUB}/api/v1/downloads`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: JSON.stringify({
        source: {
          provider: 'external-tool',
          providerTrackId: null,
          url,
          locator: null,
          title: title ?? 'Proof download',
          artistName: artist ?? 'archive.org',
        },
        // Per-fetch rights basis, exactly as the contract requires — never a one-time tick.
        authorization: { basis: 'public-domain', evidence: 'archive.org public-domain item', acknowledgedAt: new Date().toISOString(), acknowledged: true },
        target: { destination: 'hub', filenameTemplate: '{artist} - {title}', format: 'original' },
      }),
    });
    const text = await r.text();
    console.log(`POST /api/v1/downloads -> ${r.status}`);
    console.log(text);
    if (!r.ok) return 1;
    const job = JSON.parse(text);
    const s = loadSecrets();
    s.lastDownloadJob = job.jobId ?? job.id ?? null;
    saveSecrets(s);
    // Follow it to a terminal state without polling in a tight loop.
    const id = s.lastDownloadJob;
    if (!id) return 0;
    for (let i = 0; i < 90; i++) {
      const st = await fetch(`${HUB}/api/v1/downloads/${id}`, { headers: { ...headers, cookie } });
      const body = await st.json();
      console.log(`  [${i}] state=${body.state} progress=${body.progress ?? '-'} error=${body.error ?? '-'}`);
      if (['done', 'failed', 'error', 'complete', 'completed'].includes(String(body.state).toLowerCase())) {
        console.log(JSON.stringify(body, null, 2));
        return String(body.state).toLowerCase().startsWith('d') || String(body.state).toLowerCase().includes('complete') ? 0 : 3;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    console.log('job did not reach a terminal state in 4.5 minutes');
    return 4;
  });
}

async function get(path) {
  return asAdmin(async ({ cookie, headers }) => {
    const r = await fetch(`${HUB}${path}`, { headers: { ...headers, cookie } });
    console.log(`GET ${path} -> ${r.status}`);
    console.log(JSON.stringify(await r.json(), null, 2));
    return r.ok ? 0 : 1;
  });
}

const codes = {
  setup,
  providers,
  'provider-test': () => providerTest(arg('name', 'external-tool')),
  download: () => download(positional(0), positional(1), positional(2)),
  get: () => get(arg('path', '/api/v1/system/status')),
};
const fn = codes[cmd];
if (!fn) {
  console.error(`unknown command ${cmd}. known: ${Object.keys(codes).join(', ')}`);
  process.exit(2);
}
process.exit((await fn()) ?? 0);