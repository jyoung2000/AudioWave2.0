/**
 * The service-worker bridge for streaming from a PC (docs/AWSP.md §6). Imported by the generated
 * `sw.js` (vite.config.ts, `workbox.importScripts`), so it runs in the same worker as the precache.
 *
 * The media element's source is a same-origin URL, `/awsp/track/<id>`. This answers it with HTTP
 * semantics — `200`, or `206` and `Content-Range` for a `Range` request, `Content-Length`,
 * `Accept-Ranges` and a `Content-Type` from the header's codec — by asking the page that made the
 * request for the bytes over a MessageChannel. The page hands the port to its AWSP worker (the
 * iroh client), which answers with a `header`, then one `chunk` per `pull`, then `end`; a lost
 * connection mid-range is repaired there, so this stream sees no gap. Seeking is a new `Range`
 * request, which is a new AWSP audio stream; a cancelled request stops its stream.
 *
 * Safari's FLAC-in-fMP4 HLS path (`/awsp/hls/<id>/index.m3u8`) is not implemented: see §6.
 */
// The first visit is controlled at once, so remote playback works without a reload. (Updates still
// wait for the person to accept them: `sw.js` only skips waiting when the page asks it to.)
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const AWSP_MIME = { 1: 'audio/flac', 2: 'audio/mp4', 3: 'audio/mpeg', 4: 'audio/ogg', 5: 'audio/wav', 6: 'audio/mp4' };
const AWSP_TIER = ['lossless', 'high', 'saver'];

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const prefix = new URL('awsp/track/', self.registration.scope).pathname;
  if (!url.pathname.startsWith(prefix)) return;
  const id = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!id) return;
  event.respondWith(awspServe(event, id, url.searchParams.get('tag')));
});

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`; null for no header; undefined for one this cannot serve. */
function awspRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') return { start: 0, end: null, suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === '' ? null : Number(m[2]), suffix: null };
}

async function awspPage(event) {
  const own = event.clientId ? await self.clients.get(event.clientId) : null;
  if (own) return own;
  const all = await self.clients.matchAll({ type: 'window' });
  return all[0] || null;
}

async function awspServe(event, id, tag) {
  const range = awspRange(event.request.headers.get('range'));
  if (range === undefined) return new Response(null, { status: 416 });
  const page = await awspPage(event);
  if (!page) return new Response('No player page is open to stream from the PC.', { status: 503 });

  const channel = new MessageChannel();
  const port = channel.port1;
  const first = new Promise((resolve) => {
    port.onmessage = (e) => resolve(e.data);
  });
  page.postMessage({ type: 'awsp-serve', req: { track_id: id, start: range ? range.start : 0, end: range ? range.end : null, suffix: range ? range.suffix : null, tag } }, [channel.port2]);
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ type: 'error', code: 0, message: 'The PC did not answer in time.' }), 45000));
  const head = await Promise.race([first, timeout]);
  if (head.type !== 'header') {
    port.close();
    const status = head.code === 0x10 ? 404 : head.code === 0x11 ? 416 : 502;
    return new Response(head.message || 'Streaming from the PC failed.', { status, headers: { 'Content-Type': 'text/plain' } });
  }

  // The worker stays alive while the body streams (up to the browser's limit for one event).
  let finish;
  event.waitUntil(new Promise((resolve) => (finish = resolve)));
  let waiting = null;
  port.onmessage = (e) => {
    const m = e.data;
    const w = waiting;
    waiting = null;
    if (!w) return;
    if (m.type === 'chunk') w.controller.enqueue(new Uint8Array(m.bytes));
    else if (m.type === 'end') {
      w.controller.close();
      finish();
    } else {
      w.controller.error(new Error(m.message || 'Streaming from the PC failed.'));
      finish();
    }
    w.resolve();
  };
  const body = new ReadableStream(
    {
      pull(controller) {
        return new Promise((resolve) => {
          waiting = { controller, resolve };
          port.postMessage({ type: 'pull' });
        });
      },
      cancel() {
        port.postMessage({ type: 'cancel' });
        finish();
      },
    },
    { highWaterMark: 4 },
  );
  const headers = new Headers({
    'Content-Type': AWSP_MIME[head.codec] || 'application/octet-stream',
    'Content-Length': String(head.end - head.start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-AWSP-Tier': AWSP_TIER[head.tier] || String(head.tier),
  });
  if (!range) return new Response(body, { status: 200, headers });
  headers.set('Content-Range', `bytes ${head.start}-${head.end}/${head.total}`);
  return new Response(body, { status: 206, headers });
}
