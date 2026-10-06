/**
 * Driving one app through its states and reading each one out.
 *
 * The page runs on Playwright's installed clock: `Date`, timers, `requestAnimationFrame` and
 * `performance.now` stand still unless `tick` moves them. Real work (a fetch answered from a
 * recording, IndexedDB, decoding audio) is given real time to finish while the clock is held, then
 * the clock is moved on by a fixed amount — so a spinner, a "3 min ago" or a disc's angle comes out
 * the same on every run. Media elements report a position that follows that clock too
 * (`MEDIA_CLOCK`), not the sound card's; `window.__mockMediaHeld = true` holds it still while a
 * state is read (an app's beforeSnap may seek first).
 */
import { snapshotInPage, readBlobs, photographCanvases } from './capture.mjs';
import { openPage, sleep } from './browser.mjs';

/**
 * `currentTime` on audio and video follows the page's clock from the moment `play()` was called,
 * so the elapsed time, the scrubber and anything that reads the position are deterministic.
 * Seeking moves it; pausing holds it. The sound itself still plays underneath.
 */
export const MEDIA_CLOCK = `(() => {
  const proto = HTMLMediaElement.prototype;
  const real = Object.getOwnPropertyDescriptor(proto, 'currentTime');
  const state = new WeakMap();
  const now = () => performance.now() / 1000;
  const get = (el) => {
    let s = state.get(el);
    if (!s) { s = { base: 0, since: null }; state.set(el, s); }
    return s;
  };
  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get() {
      const s = get(this);
      let t = s.base + (s.since === null || window.__mockMediaHeld ? 0 : now() - s.since);
      if (Number.isFinite(this.duration) && this.duration > 0) t = Math.min(t, this.duration);
      return Math.round(t * 1000) / 1000;
    },
    set(v) {
      const s = get(this);
      s.base = Number(v) || 0;
      if (s.since !== null) s.since = now();
      try { real.set.call(this, v); } catch (e) {}
    },
  });
  const play = proto.play;
  proto.play = function () {
    const s = get(this);
    if (s.since === null) s.since = now();
    return play.apply(this, arguments);
  };
  const pause = proto.pause;
  proto.pause = function () {
    const s = get(this);
    if (s.since !== null) { s.base += now() - s.since; s.since = null; }
    return pause.apply(this, arguments);
  };
  const load = proto.load;
  proto.load = function () { state.set(this, { base: 0, since: null }); return load.apply(this, arguments); };
  const src = Object.getOwnPropertyDescriptor(proto, 'src');
  Object.defineProperty(proto, 'src', {
    configurable: true,
    get() { return src.get.call(this); },
    set(v) { state.set(this, { base: 0, since: null }); src.set.call(this, v); },
  });
})();`;

/**
 * Render one app. `app.run(session)` drives it; each `session.snap(state)` reads one state out.
 * Returns the states, plus what the page asked for that nothing answered and any script errors.
 */
export async function renderApp(browser, app, prepared) {
  const { context, page, errors, unanswered } = await openPage(browser, {
    viewport: app.viewport,
    locale: app.locale,
    timezoneId: app.timezoneId,
    now: prepared.now,
    origin: prepared.origin,
    dist: prepared.dist,
    routes: prepared.routes,
    init: [MEDIA_CLOCK, ...(prepared.init ?? [])],
  });
  // Installed a minute early and paused at the moment itself: from here on, time moves only by `tick`.
  await page.clock.install({ time: new Date(Date.parse(prepared.now) - 60_000) });
  await page.clock.pauseAt(new Date(prepared.now));
  const states = [];
  const seen = new Set();

  // Requests in flight: the clock is not moved until each has been answered and its answer read,
  // so "200 · 0 ms" and a reply's place among the timers come out the same on every run.
  let inflight = 0;
  page.on('request', () => (inflight += 1));
  for (const done of ['requestfinished', 'requestfailed']) page.on(done, () => (inflight = Math.max(0, inflight - 1)));
  const quiet = async () => {
    // First a moment for a request the page has just made to be reported at all.
    await sleep(60);
    for (let i = 0; i < 150 && inflight > 0; i += 1) await sleep(20);
    await sleep(60);
  };
  const tick = async (ms = 100) => {
    await quiet();
    await page.clock.runFor(ms);
    await quiet();
  };
  const settle = async (ms = 600) => {
    for (let t = 0; t < ms; t += 100) await tick(100);
  };
  /**
   * Wait for something in the page. Real time first, with the clock held — most waits are for real
   * work (a database, a decoder, a reply) — and only then by moving the clock, a fixed step at a time.
   */
  const until = async (predicate, arg, { max = 20_000, what = 'the page' } = {}) => {
    for (let waited = 0; waited < 3000; waited += 50) {
      if (await page.evaluate(predicate, arg).catch(() => false)) return;
      await sleep(50);
    }
    for (let waited = 0; waited < max; waited += 100) {
      if (await page.evaluate(predicate, arg).catch(() => false)) return;
      await tick(100);
    }
    throw new Error(`${app.id}: ${what} did not happen`);
  };
  /** Run something in the page: real time first with the clock held, then moving it if it waits on a timer. */
  const evaluate = async (fn, arg) => {
    let done = false;
    const result = page.evaluate(fn, arg).finally(() => {
      done = true;
    });
    for (let waited = 0; waited < 15_000 && !done; waited += 50) await sleep(50);
    while (!done) await tick(100);
    return result;
  };
  const click = async (selector, { ms = 600, button = 'left', position } = {}) => {
    await page.locator(selector).first().click({ force: true, button, ...(position ? { position } : {}), timeout: 10_000 });
    // What the click set off in real time (a request, a read) finishes before the clock moves.
    await quiet();
    await sleep(150);
    await settle(ms);
  };
  const snap = async (state) => {
    if (seen.has(state.id)) throw new Error(`${app.id}: state ${state.id} was read twice`);
    seen.add(state.id);
    await settle(state.settle ?? 400);
    await page.mouse.move(0, 0);
    if (app.beforeSnap) await app.beforeSnap(page, state);
    const links = app.links.filter((link) => link.to !== state.id && (!link.in || link.in.includes(state.id)) && (!link.notIn || !link.notIn.includes(state.id)));
    const blobs = await readBlobs(page);
    const shot = await page.evaluate(snapshotInPage, { links, blobs });
    let pictures = [];
    if (shot.pictures && app.pictures !== false) {
      // One frame, then time for it to reach the screen: a run of frames drawn back to back may
      // reach it out of step, and the photograph would catch an earlier one on some runs.
      await page.clock.runFor(17);
      await sleep(300);
      pictures = await photographCanvases(page, shot.pictures);
    }
    if (app.afterSnap) await app.afterSnap(page, state);
    states.push({ ...state, html: shot.html, body: shot.body, styles: shot.styles, pictures });
    // The page's clock at this state, from the moment the walk-through began: the same on every run.
    const at = await page.evaluate((start) => Date.now() - start, Date.parse(prepared.now));
    console.info(`  ${app.id}: ${state.id} (at +${(at / 1000).toFixed(1)} s)`);
  };

  try {
    await app.run({ page, tick, settle, until, evaluate, click, snap, origin: prepared.origin, prepared, sleep });
  } finally {
    await context.close();
  }
  return { states, errors, unanswered: [...unanswered].sort() };
}
