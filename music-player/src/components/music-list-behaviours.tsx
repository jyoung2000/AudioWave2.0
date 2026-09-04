/**
 * The three things the reference's list does that a plain table does not.
 *
 * All three are ports of `docs/reference/now-playing-header.html`'s own code, with its reasoning
 * intact. They live outside `MusicList.tsx` because each is a self-contained imperative machine —
 * a rAF loop, a pointer-drag scroller, a roving menu — and mixing them into the render function
 * would bury the markup they exist to serve.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Playlist, PlaylistItem, Track } from '@now-playing/contracts';

/* --------------------------------------------------------------------- marquee */

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

/** UIView's ease-in-out: sinusoidal, peaking at about 1.57× the mean rate. */
function ease(t: number): number {
  return 0.5 - Math.cos(Math.PI * t) / 2;
}

/**
 * The playing row's label marquee.
 *
 * Apple's label marquee does not loop like a ticker. It parks, glides far enough left to show the
 * tail, parks again, glides back. Distance is *measured*, never assumed, so the text stops with its
 * last letter flush to the right edge rather than overshooting into empty space; duration follows
 * from a fixed rate, so a long title takes longer than a short one and the apparent speed stays
 * constant. Title and artist share one clock — they leave and arrive together even though they
 * travel different distances — because two labels in one row drifting out of step reads as a bug.
 */
export function useMarquee(tbodyRef: RefObject<HTMLTableSectionElement | null>, playingTrackId: string | null, rows: readonly Track[]): void {
  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || !playingTrackId) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;

    const boxes = [...tbody.querySelectorAll<HTMLElement>('tr.is-playing .lib-mq')];
    if (!boxes.length) return;

    const items: MarqueeItem[] = boxes.map((box) => ({ box, ink: box.firstElementChild as HTMLElement, dist: 0, dur: MIN_MS, x: 0, fadeLeft: 0, fadeRight: 0 }));
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

    // The columns hide at breakpoints, so a cell's width changes without the window ever firing
    // resize at this element.
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
  }, [tbodyRef, playingTrackId, rows]);
}

/* ------------------------------------------------------------------- scroller */

/**
 * The overlay gel scroller: visible while scrolling or dragging, gone 900 ms after the last move.
 *
 * Built from elements because native scrollbar internals cannot animate opacity, and appearing and
 * dissolving is the whole character of this one. The thumb drags, the track takes a click, and the
 * wheel and keyboard scroll the container natively underneath it.
 */
export function useOverlayScroller(
  scrollRef: RefObject<HTMLDivElement | null>,
  barRef: RefObject<HTMLDivElement | null>,
  thumbRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLDivElement | null>,
  rowCount: number,
): void {
  useEffect(() => {
    const scroller = scrollRef.current;
    const bar = barRef.current;
    const thumb = thumbRef.current;
    const list = listRef.current;
    if (!scroller || !bar || !thumb || !list) return;

    let hideTimer = 0;
    let dragging = false;
    let dragY = 0;
    let dragTop = 0;

    const metrics = (): { view: number; full: number; max: number; trackH: number } => ({
      view: scroller.clientHeight,
      full: scroller.scrollHeight,
      max: scroller.scrollHeight - scroller.clientHeight,
      trackH: bar.clientHeight,
    });

    const update = (): void => {
      const m = metrics();
      if (m.max <= 0) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = '';
      const height = Math.max(26, Math.round((m.trackH * m.view) / m.full));
      const top = Math.round((m.trackH - height) * (scroller.scrollTop / m.max));
      thumb.style.height = `${height}px`;
      thumb.style.transform = `translateY(${top}px)`;
    };

    const show = (): void => {
      list.classList.add('is-scrolling');
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (!dragging) list.classList.remove('is-scrolling');
      }, 900);
    };

    const onScroll = (): void => {
      update();
      show();
    };
    const onThumbDown = (event: PointerEvent): void => {
      dragging = true;
      dragY = event.clientY;
      dragTop = scroller.scrollTop;
      thumb.setPointerCapture(event.pointerId);
      show();
      event.preventDefault();
    };
    const onThumbMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const m = metrics();
      const span = m.trackH - thumb.offsetHeight;
      if (span > 0) scroller.scrollTop = dragTop + (event.clientY - dragY) * (m.max / span);
    };
    const endDrag = (): void => {
      if (!dragging) return;
      dragging = false;
      show();
    };
    const onBarDown = (event: PointerEvent): void => {
      if (event.target === thumb) return;
      const m = metrics();
      const span = m.trackH - thumb.offsetHeight;
      const y = event.clientY - bar.getBoundingClientRect().top - thumb.offsetHeight / 2;
      if (span > 0) scroller.scrollTop = Math.max(0, Math.min(1, y / span)) * m.max;
      show();
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', update);
    thumb.addEventListener('pointerdown', onThumbDown);
    thumb.addEventListener('pointermove', onThumbMove);
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
    bar.addEventListener('pointerdown', onBarDown);
    update();

    return () => {
      window.clearTimeout(hideTimer);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', update);
      thumb.removeEventListener('pointerdown', onThumbDown);
      thumb.removeEventListener('pointermove', onThumbMove);
      thumb.removeEventListener('pointerup', endDrag);
      thumb.removeEventListener('pointercancel', endDrag);
      bar.removeEventListener('pointerdown', onBarDown);
    };
  }, [scrollRef, barRef, thumbRef, listRef, rowCount]);
}

/* ----------------------------------------------------------------- row menu */

export interface RowMenuProps {
  track: Track;
  x: number;
  y: number;
  playlists: readonly Playlist[];
  playlistItems: readonly PlaylistItem[];
  onTogglePlaylist: (track: Track, playlistId: string) => void;
  onNewPlaylist: (track: Track | null) => void;
  onClose: () => void;
}

/**
 * The reference's context menu: Add to Playlist with a submenu of checkmarks, a separator, and New
 * Playlist… — plus New Playlist… at the top level.
 *
 * The submenu flips to the left when it would run off the right edge, the menu clamps itself inside
 * the viewport, and the whole thing is walkable with the arrow keys: Right opens the submenu, Left
 * closes it, Escape dismisses and returns focus to the row it came from.
 */
export function RowMenu({ track, x, y, playlists, playlistItems, onTogglePlaylist, onNewPlaylist, onClose }: RowMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ left: number; top: number; flip: boolean } | null>(null);

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPlacement({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
      flip: x + rect.width + 210 > window.innerWidth,
    });
    menu.querySelector<HTMLElement>('.ctx__item')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = useCallback((delta: 1 | -1) => {
    const menu = ref.current;
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('.ctx__item:not([disabled])')].filter((el) => el.offsetParent !== null);
    const at = items.indexOf(document.activeElement as HTMLElement);
    (items[at + delta] ?? items[delta === 1 ? 0 : items.length - 1])?.focus();
  }, []);

  const inPlaylist = (playlistId: string): boolean => playlistItems.some((item) => item.playlistId === playlistId && item.track.trackId === track.id);

  return (
    <div
      className="ctx"
      role="menu"
      tabIndex={-1}
      aria-label="Song actions"
      ref={ref}
      style={placement ? { left: placement.left, top: placement.top } : { left: -9999, top: -9999 }}
      onKeyDown={(event) => {
        const parent = ref.current?.querySelector<HTMLElement>('.ctx__item--parent');
        if (event.key === 'Escape') onClose();
        else if (event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') move(-1);
        else if (event.key === 'ArrowRight' && document.activeElement === parent) {
          setOpen(true);
          requestAnimationFrame(() => parent?.querySelector<HTMLElement>('.ctx__sub .ctx__item:not([disabled])')?.focus());
        } else if (event.key === 'ArrowLeft' && open && document.activeElement !== parent) {
          setOpen(false);
          parent?.focus();
        } else return;
        event.preventDefault();
      }}
    >
      <div
        className={['ctx__item', 'ctx__item--parent', open && 'is-open'].filter(Boolean).join(' ')}
        role="menuitem"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={(event) => {
          // Enter and Space open the submenu from the parent row itself; the container's handler
          // owns the arrows, so it must not see these twice.
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setOpen((was) => !was);
        }}
      >
        Add to Playlist
        <span className="ctx__chev" aria-hidden="true">
          ›
        </span>
        <div className={['ctx__sub', placement?.flip && 'is-flip'].filter(Boolean).join(' ')} role="menu" aria-label="Playlists">
          {playlists.length ? (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                className="ctx__item"
                type="button"
                role="menuitemcheckbox"
                aria-checked={inPlaylist(playlist.id)}
                onClick={(event) => {
                  event.stopPropagation();
                  onTogglePlaylist(track, playlist.id);
                  onClose();
                }}
              >
                <span className="ctx__check" aria-hidden="true">
                  {inPlaylist(playlist.id) ? '✓' : ''}
                </span>
                {playlist.name}
              </button>
            ))
          ) : (
            <button className="ctx__item" type="button" role="menuitem" disabled>
              No playlists yet
            </button>
          )}
          <div className="ctx__sep" role="separator" />
          <button
            className="ctx__item"
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
              onNewPlaylist(track);
            }}
          >
            New Playlist…
          </button>
        </div>
      </div>
      <button
        className="ctx__item"
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onNewPlaylist(null);
        }}
      >
        New Playlist…
      </button>
    </div>
  );
}
