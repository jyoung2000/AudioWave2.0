#!/usr/bin/env node
/**
 * §2.11 — two real downloads through the companion, with its own Downloads settings doing the work.
 *
 * The player talks to the companion's helper over HTTP (music-player/src/lib/tools-core.ts), and
 * local-helper/src/server.ts:289-294 deliberately applies THIS PC's Downloads settings when the
 * request names no format of its own. So a fetch sent without a format proves the setting is what
 * decided the format — which is the claim under test.
 *
 * The helper lives inside the companion's process, so the companion is launched here and the
 * requests go to its port while it is up. The helper token is read from the companion's own store
 * and is never printed and never written to a file.
 *
 *   node .agents/evidence/harness/companion-downloads.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
const CLONE = process.env.NP_CLONE;
const EVIDENCE = join(SCRATCH, 'evidence');
const DL = join(SCRATCH, 'downloads');
mkdirSync(EVIDENCE, { recursive: true });
mkdirSync(DL, { recursive: true });
const PORT = Number(process.env.NP_HELPER_PORT ?? 17342);
const log = (m) => console.log(m);
const lines = [];
const say = (m) => {
  log(m);
  lines.push(String(m));
};

// Two public-domain recordings from the US Naval Academy's Glee Club (1920s), served by Wikimedia
// Commons. archive.org was tried first and answered HTTP 503 to this machine for every request, so
// these stand in: they are openly licensed, and they are big enough (2.5 MB, 2.8 MB) that a 500 KB/s
// limit is measurable against an unthrottled 6.1 MB/s.
const TRACKS = [
  {
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/b3/%22Anchors_Aweigh%22%2C_sung_by_the_U.S._Naval_Academy%27s_Midshipmen_Glee_Club.mp3',
    title: 'Anchors Aweigh',
    artist: "US Naval Academy Midshipmen Glee Club",
  },
  {
    url: 'https://upload.wikimedia.org/wikipedia/commons/6/62/%22Blow_The_Man_Down%22_sung_by_the_U.S._Naval_Academy%27s_Midshipmen_Glee_Club.mp3',
    title: 'Blow the Man Down',
    artist: "US Naval Academy Midshipmen Glee Club",
  },
];
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
const comp = await app.firstWindow();
await comp.waitForLoadState('domcontentloaded');
await comp.waitForTimeout(1500);
await comp.getByRole('tab', { name: 'Settings', exact: false }).first().click({ timeout: 20_000 });
await comp.waitForTimeout(1200);

/* ------------------------------------------------------------- the Downloads settings, set by hand */
const readDownloads = () =>
  comp.evaluate(() => {
    const val = (id) => document.querySelector(`#${id}`)?.value ?? null;
    const opts = (id) => [...(document.querySelector(`#${id}`)?.options ?? [])].map((o) => o.value);
    return {
      format: val('downloads-format'),
      formatOptions: opts('downloads-format'),
      concurrency: val('downloads-jobs'),
      rateLimit: val('downloads-speed'),
      onDone: val('downloads-done'),
      onDoneOptions: opts('downloads-done'),
    };
  });

say('### Settings > Downloads, as it arrived');
say(JSON.stringify(await readDownloads(), null, 2));

say('\n### setting the options (through the controls, as a person does)');
for (const [id, value, label] of [
  ['downloads-format', 'mp3', 'Format'],
  ['downloads-done', 'notify', 'When one finishes'],
]) {
  await comp.locator(`#${id}`).selectOption(value);
  await comp.waitForTimeout(600);
  say(`  ${label}: -> ${value}`);
}
for (const [id, value, label] of [
  ['downloads-jobs', '2', 'At the same time'],
  ['downloads-speed', '500', 'Speed limit (KB/s)'],
]) {
  const f = comp.locator(`#${id}`);
  await f.fill(value);
  await f.dispatchEvent('change');
  await comp.waitForTimeout(400);
  say(`  ${label}: -> ${value}`);
}

say('\n### Settings > Downloads after the change');
say(JSON.stringify(await readDownloads(), null, 2));
await comp.screenshot({ path: join(EVIDENCE, '60-downloads-settings.png') });
say('screenshot: evidence/60-downloads-settings.png');

/* ------------------------------------------------------------- the fetches, over the helper's own API */
// The token is asked for through the companion's own bridge channel (`helper:token`,
// windows-companion/src/main/index.ts:697) — the same way the player gets one. It is never printed
// and never written to a file.
const helperToken = await comp.evaluate(async () => {
  try {
    const r = await window.companion.invoke('helper:token');
    return typeof r?.token === 'string' ? r.token : null;
  } catch (err) {
    return null;
  }
});
say(`helper token obtained through the companion's bridge: ${helperToken ? 'yes (value never printed or written)' : 'NO'}`);

async function helperFetch(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (helperToken) headers['x-helper-token'] = helperToken;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text.slice(0, 300) };
    }
  } catch (err) {
    return { status: 0, body: String(err.cause?.code ?? err.message ?? err) };
  }
}

const health = await helperFetch('/helper/v1/health');
say(`helper health: HTTP ${health.status} ${JSON.stringify(health.body?.tools ?? health.body).slice(0, 320)}`);

say('\n### queueing two public-domain tracks (no format named, so the PC setting decides)');
const jobs = [];
for (const t of TRACKS) {
  const r = await helperFetch('/helper/v1/fetch', {
    method: 'POST',
    body: JSON.stringify({
      url: t.url,
      // The rights basis is per fetch, never a one-time tick: the gate the design requires.
      authorization: { basis: 'public-domain', evidence: 'Wikimedia Commons, public-domain recording', acknowledgedAt: new Date().toISOString(), acknowledged: true },
      title: t.title,
      artist: t.artist,
    }),
  });
  say(`  ${t.title}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`);
  if (r.status === 202 || r.status === 200) jobs.push(r.body);
}

/* ------------------------------------------------------------- watch the folder: the proof */
say(`\n### watching ${DL}`);
const t0 = Date.now();
const seen = new Map();
const states = new Map();
let stableSince = null;
while (Date.now() - t0 < 300_000) {
  for (const f of readdirSync(DL)) {
    const st = statSync(join(DL, f));
    const prev = seen.get(f);
    if (!prev) {
      seen.set(f, { bytes: st.size, at: Date.now() });
      say(`  appeared: ${f}  ${st.size} bytes`);
    } else if (st.size !== prev.bytes) {
      const secs = (Date.now() - prev.at) / 1000;
      const kbps = (st.size - prev.bytes) / 1024 / secs;
      say(`  ${f}: ${st.size} bytes  (+${((st.size - (prev.bytes ?? 0)) / 1024).toFixed(0)} KB over ${secs.toFixed(1)}s = ${kbps.toFixed(1)} KB/s)`);
      prev.bytes = st.size;
      prev.at = Date.now();
      stableSince = null;
    }
  }
  for (const j of jobs) {
    const s = await helperFetch(`/helper/v1/jobs/${encodeURIComponent(j.id)}`);
    if (s.status === 200 && s.body?.state) {
      const key = j.id.slice(0, 8);
      const line = `state=${s.body.state} format=${s.body.format ?? '-'} ${s.body.error ?? ''}`;
      if (states.get(key) !== line) {
        say(`  job ${key}: ${line}`);
        states.set(key, line);
      }
    }
  }
  if (seen.size >= 2) {
    if (!stableSince) stableSince = Date.now();
    else if (Date.now() - stableSince > 10_000) break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}

say(`\n### final contents of the download folder`);
if (readdirSync(DL).length === 0) say('  (empty)');
for (const f of readdirSync(DL)) {
  const st = statSync(join(DL, f));
  say(`  ${f}  ${st.size} bytes`);
}
await comp.screenshot({ path: join(EVIDENCE, '61-downloads-finished.png') });
say('screenshot: evidence/61-downloads-finished.png');
writeFileSync(join(EVIDENCE, '60-companion-downloads.txt'), lines.join('\n'));
say('\nevidence: evidence/60-companion-downloads.txt');
await app.close();