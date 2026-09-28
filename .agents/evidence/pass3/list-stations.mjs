/** Read-only probe: list the radio directory exactly as the app renders it, so station
 *  labels are derived rather than guessed (guessing "Radio Paradise" matched 0 rows). */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
const EV = '.agents/evidence/pass3';
mkdirSync(EV, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4175/');
await page.waitForFunction(() => window.NP_READY);
await page.evaluate(() => window.NP_READY);
await page.waitForTimeout(600);
await page.click('.tb__btn[data-view="radio"]');
await page.waitForTimeout(1500);
const rows = await page.$$eval('#radioMenu .rlist tbody tr', (trs) =>
  trs.map((tr) => ({
    sid: tr.getAttribute('data-sid'),
    text: tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 90),
    cells: [...tr.querySelectorAll('td')].map((td) => td.className || td.tagName),
  }))
);
writeFileSync(`${EV}/radio-directory.json`, JSON.stringify(rows, null, 2));
console.log('stations:', rows.length);
for (const r of rows) console.log('  ', (r.sid || '').slice(0, 8), '|', r.text);
await browser.close();
