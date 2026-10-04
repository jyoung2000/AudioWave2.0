#!/usr/bin/env node
/**
 * Drives the Android app's WebView page target over the DevTools WebSocket.
 *
 * Playwright's connectOverCDP cannot be used against a WebView (it speaks the browser-level
 * protocol, and a WebView has no browser-level context management), so this speaks CDP directly to
 * the page target. It still drives the real shipped UI — the debug build enables WebView debugging
 * (MainActivity.kt:129) and this is the page the APK serves.
 *
 *   node .agents/evidence/harness/android-webview.mjs dump
 *   node .agents/evidence/harness/android-webview.mjs click-text "Radio"
 *   node .agents/evidence/harness/android-webview.mjs shot 42-android-radio
 *   node .agents/evidence/harness/android-webview.mjs eval "<js expression>"
 *   node .agents/evidence/harness/android-webview.mjs logcat-errors
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.NP_SCRATCH;
if (!SCRATCH) {
  console.error('NP_SCRATCH must be set');
  process.exit(2);
}
const EVIDENCE = join(SCRATCH, 'evidence');
mkdirSync(EVIDENCE, { recursive: true });

const PORT = Number(process.env.NP_CDP_PORT ?? 9386);
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'dump';

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page');
if (!pageTarget) {
  console.error('no page target — is the app in the foreground?');
  process.exit(3);
}

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 30_000);
  });
}

/** Evaluates an expression in the page and returns its value. */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

const INSPECT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const out = { url: location.href, title: document.title, controls: [], body: '' };
  for (const el of document.querySelectorAll('button,[role=tab],[role=button],a[href],input')) {
    if (!vis(el)) continue;
    const t = label(el) || el.placeholder || '';
    if (!t) continue;
    const r = el.getBoundingClientRect();
    out.controls.push({
      tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', id: el.id || '',
      label: t.slice(0, 70), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
    });
  }
  out.body = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 1500);
  return out;
})()`;

/** Clicks by visible label, exactly as a person does, and says what it found. */
const CLICK_BY_LABEL = `((wanted) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
  const cands = [...document.querySelectorAll('button,[role=tab],[role=button],a[href],li,tr,[data-sid]')]
    .filter((el) => vis(el) && label(el).toLowerCase() === wanted.toLowerCase());
  if (!cands.length) {
    const near = [...document.querySelectorAll('button,[role=tab],[role=button],a[href],li,tr')]
      .filter(vis).map(label).filter(Boolean).slice(0, 40);
    return { ok: false, reason: 'no control with exactly that label', nearby: near };
  }
  cands[0].scrollIntoView({ block: 'center' });
  cands[0].click();
  return { ok: true, tag: cands[0].tagName, label: label(cands[0]) };
})`;

const log = (m) => console.log(m);

switch (cmd) {
  case 'dump': {
    log(JSON.stringify(await evaluate(INSPECT), null, 2));
    break;
  }
  case 'click-text': {
    const wanted = argv[1];
    if (!wanted) throw new Error('click-text needs a label');
    const r = await evaluate(`${CLICK_BY_LABEL}(${JSON.stringify(wanted)})`);
    log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 4;
    await new Promise((res) => setTimeout(res, 2500));
    log(`page now: ${String(await evaluate('document.body.innerText.replace(/\\s+/g," ")')).slice(0, 800)}`);
    break;
  }
  case 'shot': {
    const name = argv[1] ?? 'android';
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(EVIDENCE, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    log(`saved ${file}`);
    break;
  }
  case 'eval': {
    log(JSON.stringify(await evaluate(argv.slice(1).join(' ')), null, 2).slice(0, 6000));
    break;
  }
  case 'logcat-errors': {
    const out = execSync(
      'adb logcat -d 2>&1 | grep -iE "FATAL|AndroidRuntime.*com.nowplaying|Uncaught|SecurityException|net::ERR_|ERR_ACCESS_DENIED|chromium.*CONSOLE.*rror" | grep -v AppsFilter | tail -40',
      { encoding: 'utf8' },
    );
    log(out.trim() || '(no crash, no WebView error, no failed request)');
    break;
  }
  default:
    log(`unknown command ${cmd}`);
    process.exitCode = 2;
}
ws.close();