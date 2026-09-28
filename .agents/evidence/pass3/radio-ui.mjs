/**
 * Pass 3 — NP-RADIO-001/002 driven through the real player UI in Chromium.
 *
 * Method notes (these are the differences from pass 2 that matter):
 *  - The player is paired with the REAL hub using a REAL device credential obtained
 *    through the sanctioned pairing flow (POST /pairing/sessions -> claim -> confirm
 *    -> complete). No token is read from a file or manufactured.
 *  - now-playing requests are COUNTED from real browser request events, so "only the
 *    tuned station is asked for" is measured rather than inferred from source.
 *  - Every finding is written to .agents/evidence/pass3/ as JSON, with secrets omitted.
 *
 * The credential is read from scratch at run time and never printed or written.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const SCRATCH = 'C:/Users/jalon/AppData/Local/hermes/cache/scratch';
const EV = '.agents/evidence/pass3';
const PLAYER = 'http://127.0.0.1:4175';
const sid = readFileSync(`${SCRATCH}/pass3-sid.txt`, 'utf8').trim();
const credentialId = readFileSync(`${SCRATCH}/dev-cred.txt`, 'utf8').trim();
const secret = readFileSync(`${SCRATCH}/dev-secret.txt`, 'utf8').trim();
const scopes = ['search:use', 'library:read', 'library:share', 'playlists:sync', 'group:member'];

mkdirSync(EV, { recursive: true });
const out = { startedAt: new Date().toISOString(), player: PLAYER, steps: [], notes: [] };
const log = (step, data) => {
  out.steps.push({ step, at: new Date().toISOString(), ...data });
  console.log(`[${step}]`, JSON.stringify(data).slice(0, 300));
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// Real request accounting.
const nowPlaying = [];
const allRequests = [];
page.on('request', (r) => {
  const u = r.url();
  allRequests.push(u);
  if (/radio\/now-playing/.test(u)) nowPlaying.push(u);
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

// iTunes is stubbed EMPTY on purpose, but that must not be mistaken for "search is broken": the hub
// is the first source when paired, and a real hub answer is what proves the chain. Record both
// separately so a 0-row result can be attributed to the stub rather than to a defect.
await page.route('**/itunes.apple.com/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) })
);

/** The suite's own boot(), verbatim in behaviour (_shell.ts:45-50). A plain goto is not enough:
 *  domcontentloaded fires before the shell has installed window.kv, which is why the first
 *  attempt of this driver died on `Cannot read properties of undefined (reading 'set')`. */
async function boot(hash = '') {
  await page.goto(PLAYER + '/' + hash);
  await page.waitForFunction(() => window.NP_READY);
  await page.evaluate(() => window.NP_READY);
  await page.waitForTimeout(400);
}

async function pair() {
  await boot();
  await page.evaluate(
    async (acct) => {
      await window.kv.set('player:hub', acct);
    },
    { base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3' }
  );
  const afterSet = await page.evaluate(async () => !!(await window.kv.get('player:hub')));
  await page.goto('about:blank');
  await boot();
  const afterReload = await page.evaluate(async () => {
    const v = await window.kv.get('player:hub');
    return v ? { base: v.base, hubName: v.hubName, hasSecret: !!v.secret, scopes: v.scopes } : null;
  });
  log('pair', { afterSet, afterReload });
  if (!afterReload) out.notes.push('player:hub did not survive reload — pairing unproven in the UI');
}

await pair();

// ---- 2.1: search + pasted link, counting 8642 hits in the real browser ----
nowPlaying.length = 0;
await page.fill('#q', 'Golden Hour');
await page.press('#q', 'Enter');
await page.waitForTimeout(2500);
const searchRows = await page.locator('.srch__row').count();
const searchAsked = allRequests.filter((u) => /api\/v1\/search|itunes/.test(u));
log('search', { rows: searchRows, asked: searchAsked.map((u) => u.replace(/[?].*/, '?…')), to8642: allRequests.filter((u) => /:8642/.test(u)).length });

const before = allRequests.length;
await page.fill('#q', 'https://soundcloud.com/someone/some-song');
await page.press('#q', 'Enter');
await page.waitForTimeout(2000);
log('pasted-link', { to8642: allRequests.filter((u) => /:8642/.test(u)).length, new: allRequests.slice(before).map((u) => u.slice(0, 90)) });

// ---- 3.1: the radio tab ----
await page.click('.tb__btn[data-view="radio"]');
await page.waitForTimeout(1500);
const stations = await page.locator('#radioMenu .rlist tbody tr').count();
// Clear the counter AFTER the directory renders, so any later call is attributable to tuning.
const npAfterDirectory = nowPlaying.length;
log('radio-directory', { stations, nowPlayingDuringDirectory: npAfterDirectory });

// Tune one station by double-click, as a person would. Station labels were READ from the running
// directory (evidence/pass3/radio-directory.json) rather than guessed: the brief's WFMT/WDCB/KEXP/
// Radio Paradise are not all present in this Chicago-scoped directory (011.fm is), and the guessed
// "Radio Paradise" matched 0 rows. WLS 94.7-FM shows a real ICY title already, so it is the
// candidate most likely to yield a title the hub can then be asked to keep (NP-RADIO-002).
const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
const tunedUrlBefore = await page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);
await row.dblclick();
await page.waitForTimeout(20000);
const headline = await page.locator('.player__title').textContent().catch(() => null);
const rowSong = await row.locator('.rlist-song').textContent().catch(() => null);
const rowArtist = await row.locator('.rlist-artist').textContent().catch(() => null);
log('tuned', {
  tunedUrlBefore,
  headline, rowSong, rowArtist,
  nowPlayingCalls: nowPlaying.length - npAfterDirectory,
  nowPlayingUrls: [...new Set(nowPlaying.slice(npAfterDirectory))].map((u) => u.slice(0, 120)),
});

await page.screenshot({ path: `${EV}/radio-tuned.png` });

// ---- 3.2: the On air menu (browser interaction, not a header probe) ----
nowPlaying.length = 0;
await row.click({ button: 'right', position: { x: 120, y: 8 } });
await page.waitForTimeout(600);
const menuHead = await page.locator('#ctx .ctx__head').textContent().catch(() => null);
const items = await page.locator('#ctx > .ctx__item').allTextContents();
const groupItem = page.locator('#ctx button', { hasText: 'Add Song to Group Queue' });
const groupDisabled = await groupItem.isDisabled().catch(() => null);
const groupTitle = await groupItem.getAttribute('title').catch(() => null);
log('context-menu', { menuHead, items: items.map((s) => s.trim()), groupDisabled, groupTitle });

// Prove the gesture did not retune: the playing row's stream id must be unchanged.
const playingAfter = await page.locator('#radioMenu .rlist tbody tr.is-playing, #radioMenu .rlist tbody tr[aria-selected="true"]').first().getAttribute('data-sid').catch(() => null);
const nowPlayingTitleNow = await page.locator('.player__title').textContent().catch(() => null);
log('gesture-no-retune', { tunedUrlBefore, playingAfter, equal: tunedUrlBefore === playingAfter, nowPlayingTitleNow });

await page.screenshot({ path: `${EV}/radio-context-menu.png` });

out.pageErrors = pageErrors;
out.totalRequests = allRequests.length;
out.requestsTo8642 = allRequests.filter((u) => /:8642/.test(u));
writeFileSync(`${EV}/radio-ui-results.json`, JSON.stringify(out, null, 2));
console.log('\nWROTE', `${EV}/radio-ui-results.json`);
await browser.close();
