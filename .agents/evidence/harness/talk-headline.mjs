#!/usr/bin/env node
/**
 * §2.7 — the talk-station headline. Pass 4 saw "No group session" and "Classical" at the top of the
 * player when it expected a station's programme format, possibly because it clicked a neighbouring
 * row. This tunes each station by its OWN data-sid and reads the headline, so the row clicked is
 * the row named.
 *
 *   node .agents/evidence/harness/talk-headline.mjs WBEZ FM 91.5
 *   node .agents/evidence/harness/talk-headline.mjs "WGN Radio 720" --group
 */
const PORT = Number(process.env.NP_CDP_PORT ?? 9386);
const argv = process.argv.slice(2);
const wanted = argv.find((a) => !a.startsWith('--')) ?? 'WBEZ FM 91.5';
const GROUP = argv.includes('--group');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page');
let nextId = 1;
const pending = new Map();
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))), 30_000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

if (GROUP) {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button[role=radio]')].find((x) => /group listening/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'no group button';
    if (b.getAttribute('aria-checked') === 'true') return 'already group';
    b.click(); return 'switched to group listening';
  })()`).then((r) => console.log(`group mode: ${r}`));
} else {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button[role=radio]')].find((x) => /solo listening/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return 'no solo button';
    if (b.getAttribute('aria-checked') === 'true') return 'already solo';
    b.click(); return 'switched to solo listening';
  })()`).then((r) => console.log(`solo mode: ${r}`));
}

// Make sure the Radio tab is the one showing, then find the row by its own text.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Radio');
  if (b) b.click();
  return !!b;
})()`);
await new Promise((r) => setTimeout(r, 1500));

// Click the row ITSELF, selected by the text inside that row — never by index.
const found = await evaluate(`(() => {
  const wanted = ${JSON.stringify(wanted)}.toLowerCase();
  const rows = [...document.querySelectorAll('[data-sid]')];
  const row = rows.find((r) => (r.innerText || '').toLowerCase().includes(wanted));
  if (!row) return { ok: false, reason: 'no row contains that text', rows: rows.slice(0, 30).map((r) => (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50)) };
  row.scrollIntoView({ block: 'center' });
  const sid = row.getAttribute('data-sid');
  const rowText = (row.innerText || '').replace(/\\s+/g, ' ').trim();
  // A single click on the row is what tunes a station (music-player/index.html:11439 binds 'click'
  // to radioChoose); §2.7 says double-click, and a dblclick additionally fires pointerdown/up,
  // which the same view treats as a click-drag and cancels. Click the row itself once.
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
  return { ok: true, sid, rowText };
})()`);
console.log(`row clicked: ${JSON.stringify(found)}`);

await new Promise((r) => setTimeout(r, 7000));

const headline = await evaluate(`(() => {
  const txt = (document.body.innerText || '').replace(/\\s+/g, ' ');
  // The headline sits between the "Now Playing" title and the transport controls; read the first
  // few hundred characters, which is where pass 4 saw the wrong words.
  const i = txt.indexOf('Now Playing');
  const slice = i >= 0 ? txt.slice(i, i + 220) : txt.slice(0, 220);
  const play = document.querySelector('#play');
  return { top: slice, play: play?.getAttribute('aria-label') || null };
})()`);
console.log(`\nHEADLINE after tuning ${wanted} (${GROUP ? 'group' : 'solo'}):\n  ${headline.top}`);
console.log(`  play button: ${headline.play}`);

const shot = `43-android-headline-${wanted.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${GROUP ? '-group' : '-solo'}`;
const r = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');
mkdirSync(join(process.env.NP_SCRATCH, 'evidence'), { recursive: true });
writeFileSync(join(process.env.NP_SCRATCH, 'evidence', `${shot}.png`), Buffer.from(r.data, 'base64'));
console.log(`screenshot: evidence/${shot}.png`);
ws.close();