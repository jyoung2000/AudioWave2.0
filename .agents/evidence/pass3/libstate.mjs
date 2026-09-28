/** Pass 3 — close the one PARTIAL: what is actually inside shell:library:state after Up Next + reload?
 *  Previous runs showed the KEY appearing and surviving reload, but never read its contents, so the
 *  kept song's presence was inferred rather than proven. */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const SCRATCH = 'C:/Users/jalon/AppData/Local/hermes/cache/scratch';
const EV = '.agents/evidence/pass3';
const credentialId = readFileSync(`${SCRATCH}/dev-cred.txt`, 'utf8').trim();
const secret = readFileSync(`${SCRATCH}/dev-secret.txt`, 'utf8').trim();
const scopes = ['search:use', 'library:read', 'library:share', 'playlists:sync', 'group:member'];
const out = { startedAt: new Date().toISOString(), steps: [] };
const log = (s, d) => { out.steps.push({ step: s, ...d }); console.log(`[${s}]`, JSON.stringify(d).slice(0, 900)); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const boot = async () => {
    await page.goto('http://127.0.0.1:4175/');
    await page.waitForFunction(() => window.NP_READY);
    await page.evaluate(() => window.NP_READY);
    await page.waitForTimeout(500);
  };
  const libState = () => page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('now-playing', 1); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (!db) return { error: 'no db' };
    return new Promise((res) => {
      const rq = db.transaction('settings', 'readonly').objectStore('settings').get('shell:library:state');
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => res({ error: true });
    });
  });

  await boot();
  await page.evaluate((a) => window.kv.set('player:hub', a), { base: 'http://127.0.0.1:4546', credentialId, secret, scopes, hubName: 'Now Playing Hub', deviceId: 'pass3' });
  await page.goto('about:blank');
  await boot();

  const before = await libState();
  log('library-state-before', before);

  await page.click('.tb__btn[data-view="radio"]');
  await page.waitForSelector('#radioMenu .rlist tbody tr', { timeout: 15000 });
  const row = page.locator('#radioMenu .rlist tbody tr', { hasText: 'WLS 94.7-FM' }).first();
  await row.dblclick();
  await page.waitForTimeout(15000);
  const onAir = { song: await row.locator('.rlist-song').textContent().catch(() => null), artist: await row.locator('.rlist-artist').textContent().catch(() => null) };
  log('on-air', onAir);

  await row.click({ button: 'right', position: { x: 120, y: 8 } });
  await page.waitForTimeout(700);
  await page.click('#ctx [data-act="ls-air-next"]');
  await page.waitForTimeout(2000);
  const toast = await page.locator('#toast').textContent().catch(() => null);
  const afterClick = await libState();
  log('after-up-next', { toast, onAir, libraryState: afterClick });

  await boot();
  await page.waitForTimeout(1000);
  const afterReload = await libState();
  log('after-reload', afterReload);
  await page.screenshot({ path: `${EV}/p3d-library-after-reload.png` });
} catch (e) {
  log('FAILED', { error: String(e).split('\n').slice(0, 3).join(' | ') });
} finally {
  writeFileSync(`${EV}/p3d-library-state.json`, JSON.stringify(out, null, 2));
  console.log('WROTE', `${EV}/p3d-library-state.json`);
  await browser.close();
}
