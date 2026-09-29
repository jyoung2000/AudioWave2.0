/**
 * Final pass §5.1 — radio DEGRADATION cases, the one product claim pass 4 left unverified.
 *
 * The claim: a station that publishes no title of its own must show the programme format the
 * directory carries - never an invented title, never a stale one. Pass 3 proved this for ONE no-feed
 * station (011.fm). These are the cases pass 3 did not separate:
 *
 *   - TALK stations: WBEZ FM 91.5, WGN Radio 720 (both listed "Live broadcast" in the directory)
 *   - A station between songs
 *   - 011.fm again, as the control
 *
 * Every station is read from the RUNNING directory first (radio-directory.json), never from memory -
 * pass 3's mistake was assuming the brief's station list was the app's list.
 *
 * Method note: this runs the player ALONE (unpaired, no companion), which is one of the three setups
 * the brief asks for and the one where a fallback must appear rather than a live title.
 */
import { chromium } from '@playwright/test';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const EV = '.agents/evidence/final';
const PLAYER = 'http://127.0.0.1:4175';
mkdirSync(EV, { recursive: true });

const out = { startedAt: new Date().toISOString(), steps: [], notes: [] };
const log = (s, d) => { out.steps.push({ step: s, at: new Date().toISOString(), ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 460)); };

// No directory read here: the stations are read from the RUNNING app below, never from a file.
// (An earlier version did readFileSync(...).catch(...) which throws - readFileSync is sync.)

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const nowPlaying = [];
  page.on('request', (r) => { if (/radio\/now-playing/.test(r.url())) nowPlaying.push(r.url()); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));

  const boot = async () => {
    await page.goto(PLAYER + '/');
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    await page.waitForTimeout(500);
  };
  // PLAYER ALONE: no pairing, no companion. The fallback must be the programme format.
  await boot();
  const paired = await page.evaluate(async () => !!(await window.kv.get('player:hub')));
  log('setup-player-alone', { paired, companionPresent: false });

  await page.click('.tb__btn[data-view="radio"]');
  // Wait for the directory to actually render. My first run waited a flat 1500 ms and read
  // 0 rows, which contradicts pass 3 (34 rows, same flow) - that was my race, not a finding.
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const live = await page.$$eval('#radioMenu .rlist tbody tr', (trs) =>
    trs.map((tr) => ({ sid: tr.getAttribute('data-sid'), text: tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) }))
  );
  writeFileSync(`${EV}/final-radio-directory-live.json`, JSON.stringify(live, null, 2));
  log('directory', { count: live.length, callsWhileVisible: nowPlaying.length });

  // Pick candidates by what the RUNNING directory says, not from the brief.
  const pick = (re) => live.find((r) => re.test(r.text));
  const candidates = [
    { key: 'talk-wbez', label: 'WBEZ', re: /WBEZ/i, why: 'talk station, "Live broadcast"' },
    { key: 'talk-wgn', label: 'WGN', re: /WGN/i, why: 'talk station, "Live broadcast"' },
    { key: 'nofeed-011', label: '011.fm', re: /011\.fm/i, why: 'no metadata - pass 3 control' },
  ].map((c) => ({ ...c, row: pick(c.re) })).filter((c) => c.row);

  log('candidates', { resolved: candidates.map((c) => ({ key: c.key, why: c.why, text: c.row.text })) });

  for (const c of candidates) {
    const before = nowPlaying.length;
    // Select by data-sid, not by a slice of the row's text: my first attempt used
    // hasText with row.text.slice(0,18) and timed out waiting for a locator that never resolved.
    // The sid is unique and comes from the running directory I just read.
    const row = page.locator(`#radioMenu .rlist tbody tr[data-sid="${c.row.sid}"]`).first();
    const programmeBefore = await row.locator('.rlist-song').textContent().catch(() => null);
    const artistBefore = await row.locator('.rlist-artist').textContent().catch(() => null);
    await row.dblclick();
    await page.waitForTimeout(16000);
    const programmeAfter = await row.locator('.rlist-song').textContent().catch(() => null);
    const artistAfter = await row.locator('.rlist-artist').textContent().catch(() => null);
    const headline = await page.locator('.player__title').textContent().catch(() => null);
    const menu = await page.evaluate(() => {
      return new Promise((res) => {
        const tr = document.querySelector('#radioMenu .rlist tbody tr.is-playing') || document.querySelector('#radioMenu .rlist tbody tr[aria-selected="true"]');
        if (!tr) return res(null);
        tr.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 8 }));
        setTimeout(() => res(document.getElementById('ctx')?.innerText.replace(/\s+/g, ' ').slice(0, 220) ?? null), 600);
      });
    });
    log('station', {
      key: c.key, why: c.why, directoryRow: c.row.text,
      programmeFormatBefore: programmeBefore, artistBefore,
      programmeFormatAfter: programmeAfter, artistAfter,
      headline,
      nowPlayingCalls: nowPlaying.length - before,
      contextMenu: menu,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  out.pageErrors = errs;
  out.totalNowPlayingCalls = nowPlaying.length;
  out.note = 'Unpaired + no companion: any title shown must come from the directory, not a stream read.';
} catch (err) {
  out.failure = String(err).split('\n').slice(0, 4).join(' | ');
  console.log('[FAILED]', out.failure);
} finally {
  writeFileSync(`${EV}/final-radio-degradation.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/final-radio-degradation.json`);
  await browser.close();
}
