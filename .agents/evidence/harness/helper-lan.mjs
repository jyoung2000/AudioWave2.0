#!/usr/bin/env node
/**
 * §2.9 — the helper on the network, in one pass.
 *
 * The companion's own toggle (Settings ▸ Network, off by default) is what opens the LAN routes, so
 * this drives that toggle through the companion's UI rather than setting an environment variable.
 * The helper lives inside the companion's process, so the probe has to run while the companion is
 * up — that is why this is one script rather than two.
 *
 * Requests are made against this PC's own LAN address with a Host header spelled the way a browser
 * on another device sends it, because the helper refuses anything that is not one of its own
 * addresses (local-helper/src/security.ts:146 — the DNS-rebinding check). A request from loopback
 * would pass anyway and prove nothing about the network.
 *
 * The Firewall prompt Windows shows when the helper starts listening on 0.0.0.0 can only be
 * answered by a person. This script prints that it is waiting and keeps going, so the transcript
 * records that the answer came from a person rather than assuming it.
 *
 *   node .agents/evidence/harness/helper-lan.mjs
 */
import { _electron as electron } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const PORT = Number(process.env.NP_HELPER_PORT ?? 17342);
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });
const log = (m) => console.log(m);
const lines = [];
const say = (m) => {
  log(m);
  lines.push(String(m));
};

/** This PC's own IPv4 addresses; on the LAN the helper only answers for one of these. */
function lanAddresses() {
  const out = execSync('ipconfig', { encoding: 'utf8' }).split(/\r?\n/);
  const found = [];
  let inV4 = false;
  for (const line of out) {
    if (/IPv4 Address|IPv4-adress|IPv4-adre/.test(line)) inV4 = true;
    else if (/adapter/i.test(line)) inV4 = false;
    if (inV4) {
      const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      if (m) found.push(m[1]);
    }
  }
  return found;
}

const ADDRS = lanAddresses();
const LAN = ADDRS.find((a) => a.startsWith('192.168.')) ?? ADDRS.find((a) => a.startsWith('10.')) ?? ADDRS[0];
say(`this PC's IPv4 addresses: ${ADDRS.join(', ')}`);
say(`probing over the LAN address: ${LAN}  (loopback would pass the check and prove nothing)\n`);

/** One request, as a device on the LAN would send it. */
async function lanFetch(path, { origin, host, token, method = 'GET', body } = {}) {
  const headers = { host: host ?? `${LAN}:${PORT}` };
  if (origin) headers.origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const t0 = Date.now();
  try {
    const r = await fetch(`http://${LAN}:${PORT}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t0, body: text.slice(0, 240) };
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, body: String(err.cause?.code ?? err.message ?? err) };
  }
}

async function probe(tag) {
  const results = [];
  results.push({ route: 'GET /helper/v1/health', ...(await lanFetch('/helper/v1/health')) });
  results.push({ route: 'GET /helper/v1/tv/channels', ...(await lanFetch('/helper/v1/tv/channels')) });
  results.push({
    route: 'GET /helper/v1/radio/now-playing?url=<public stream>',
    ...(await lanFetch('/helper/v1/radio/now-playing?url=https%3A%2F%2Fstream.radioparadise.com%2Fmp3-32')),
  });
  // A token route from the network must be refused even when a token is presented.
  results.push({
    route: 'POST /helper/v1/fetch  (token presented, from the network)',
    ...(await lanFetch('/helper/v1/fetch', {
      method: 'POST',
      origin: `http://${LAN}:${PORT}`,
      token: 'not-a-real-token-but-well-formed',
      body: { url: 'https://example.org/a.mp3' },
    })),
  });
  say(`\n===== ${tag} =====`);
  for (const r of results) {
    say(`  ${r.status === 0 ? 'NO REPLY' : `HTTP ${r.status}`}  ${r.route}   (${r.ms}ms)`);
    if (r.status !== 0) say(`       ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return results;
}

const root = join(CLONE, 'windows-companion', 'release', 'win-unpacked');
const app = await electron.launch({
  executablePath: join(root, 'Airwave Companion.exe'),
  env: {
    ...process.env,
    PORTABLE_EXECUTABLE_DIR: SCRATCH,
    NP_DATA_DIR: join(SCRATCH, 'hub'),
    NP_HELPER_PORT: String(PORT),
  },
});
say(`COMPANION_PID=${app.process().pid}`);
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
await win.getByRole('tab', { name: 'Settings', exact: false }).first().click({ timeout: 20_000 });
await win.waitForTimeout(900);

const TOGGLE = 'Let devices on this network use the helper without pairing';
const label = win.locator('label', { hasText: TOGGLE }).first();
await label.waitFor({ timeout: 15_000 });
const input = label.locator('input[type=checkbox]');
const hint = (await label.locator('xpath=..').first().innerText()).replace(/\s+/g, ' ').slice(0, 500);

say(`### toggle "${TOGGLE}"`);
say(`state on arrival: ${(await input.isChecked()) ? 'ON' : 'OFF'}   <- §2.9 requires OFF by default`);
say(`surrounding text: ${hint}`);
await win.screenshot({ path: join(EVIDENCE, '50-helper-lan-default-off.png') });

say('\n>>> turning the toggle ON. Windows may show a Firewall prompt; only a person can answer it.');
await label.click();
await win.waitForTimeout(3500);
say(`state after clicking: ${(await input.isChecked()) ? 'ON' : 'OFF'}`);
// The helper is restarted asynchronously and rebinds the socket when it does, so a request sent
// too early finds nothing listening and would be read as "the LAN routes do not work" rather than
// "the restart has not finished". Wait for the socket to answer on the LAN address.
say('waiting for the helper to rebind for this network…');
let up = false;
for (let i = 0; i < 30; i++) {
  const r = await lanFetch('/helper/v1/health');
  if (r.status !== 0) {
    up = true;
    say(`  helper answers on the LAN after ~${(i + 1) * 500}ms (HTTP ${r.status})`);
    break;
  }
  await new Promise((res) => setTimeout(res, 500));
}
if (!up) say('  the helper still does not answer on the LAN address after 15s');
await win.screenshot({ path: join(EVIDENCE, '51-helper-lan-toggled-on.png') });
await probe('LAN routes, toggle ON');

say('\n>>> turning the toggle OFF again');
await label.click();
await win.waitForTimeout(3500);
say(`state after turning off: ${(await input.isChecked()) ? 'ON' : 'OFF'}`);
await new Promise((res) => setTimeout(res, 2000));
await probe('LAN routes, toggle OFF (these must all stop answering)');
await win.screenshot({ path: join(EVIDENCE, '52-helper-lan-toggled-off.png') });

writeFileSync(join(EVIDENCE, '50-helper-lan.txt'), lines.join('\n'));
say('\nevidence: evidence/50-helper-lan.txt');
await app.close();