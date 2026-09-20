/**
 * The label marquee, once.
 *
 * Apple's label marquee does not loop like a ticker. It parks, glides far enough left to show the
 * tail, parks again, glides back. Distance is *measured*, never assumed, so the text stops with its
 * last letter flush to the right edge rather than overshooting into empty space; duration follows
 * from a fixed rate, so a long title takes longer than a short one and the apparent speed stays
 * constant. Ported from `docs/reference/now-playing-header.html` with its reasoning intact.
 *
 * Every box handed to one call shares a single clock: they leave and arrive together even though
 * they travel different distances, because two labels in one row drifting out of step reads as a
 * bug. That is why this takes a list rather than an element — it is the one thing a per-instance
 * animation cannot do, and it is why this package had two marquees before this file existed: a
 * component that animated itself, and a hook that animated a row together. Now there is one engine
 * with two entry points, `Marquee` and `useMarquee`.
 */

const HOLD = 2000; // ms parked at each end
const RATE = 38; // px/sec, averaged across the ease
const MIN_MS = 420; // floor, so a 6 px overflow is not a twitch
const MAX_MS = 6000; // ceiling for a very long title
const FADE = 12; // px of gradient over a clipped edge
const SLACK = 1; // px; sub-pixel rounding is not an overflow

interface MarqueeItem {
  box: HTMLElement;
  ink: HTMLElement;
  dist: number;
  dur: number;
  x: number;
  fadeLeft: number;
  fadeRight: number;
}

/** UIView's ease-in-out: sinusoidal, peaking at about 1.57x the mean rate. */
function ease(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}

/**
 * Animate these boxes together. Each must have exactly one element child, which is the ink that
 * moves. Returns the teardown; a call with nothing to animate is a no-op that still returns one.
 */
export function runMarquee(boxes: readonly HTMLElement[]): () => void {
  const items: MarqueeItem[] = boxes
    .filter((box) => box.firstElementChild instanceof HTMLElement)
    .map((box) => ({ box, ink: box.firstElementChild as HTMLElement, dist: 0, dur: MIN_MS, x: 0, fadeLeft: 0, fadeRight: 0 }));
  if (!items.length) return () => undefined;

  let frame = 0;
  let start = 0;

  const paint = (item: MarqueeItem, x: number): void => {
    if (Math.abs(x - item.x) > 0.05) {
      item.ink.style.transform = x ? `translate3d(${x.toFixed(2)}px,0,0)` : '';
      item.x = x;
    }
    // The fades track the travel: nothing is hidden to the left until the label has actually
    // moved, and the right edge goes hard again as the tail arrives.
    const left = Math.min(FADE, Math.max(0, -x));
    const right = Math.min(FADE, Math.max(0, item.dist + x));
    if (Math.abs(left - item.fadeLeft) > 0.05) {
      item.box.style.setProperty('--mq-fade-l', `${left.toFixed(2)}px`);
      item.fadeLeft = left;
    }
    if (Math.abs(right - item.fadeRight) > 0.05) {
      item.box.style.setProperty('--mq-fade-r', `${right.toFixed(2)}px`);
      item.fadeRight = right;
    }
  };

  const measure = (item: MarqueeItem): void => {
    const box = item.box.getBoundingClientRect().width;
    const ink = item.ink.getBoundingClientRect().width;
    item.dist = ink - box > SLACK ? ink - box : 0;
    item.dur = Math.min(MAX_MS, Math.max(MIN_MS, (item.dist / RATE) * 1000));
    if (!item.dist) paint(item, 0);
  };

  const tick = (now: number): void => {
    frame = 0;
    let span = 0;
    for (const item of items) if (item.dur > span && item.dist) span = item.dur;
    if (!span) return;
    const cycle = HOLD * 2 + span * 2;
    const p = (now - start) % cycle;
    for (const item of items) {
      if (!item.dist) continue;
      let x: number;
      if (p < HOLD) x = 0;
      else if (p < HOLD + span) x = -item.dist * ease(Math.min(1, (p - HOLD) / item.dur));
      else if (p < HOLD * 2 + span) x = -item.dist;
      else x = -item.dist * (1 - ease(Math.min(1, (p - HOLD * 2 - span) / item.dur)));
      paint(item, x);
    }
    frame = requestAnimationFrame(tick);
  };

  const run = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (items.some((item) => item.dist)) {
      start = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };

  const remeasure = (): void => {
    for (const item of items) measure(item);
    run();
  };

  remeasure();

  // Columns hide at breakpoints, so a cell's width changes without the window ever firing resize
  // at this element.
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure);
  for (const item of items) observer?.observe(item.box);

  // rAF is parked while the tab is hidden; without this the first frame back would land at an
  // arbitrary point in the cycle.
  const onVisible = (): void => {
    if (!document.hidden) run();
  };
  document.addEventListener('visibilitychange', onVisible);
  void document.fonts?.ready?.then(remeasure);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
