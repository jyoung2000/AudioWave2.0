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
import { runMarquee } from './marquee-engine.js';

/* --------------------------------------------------------------------- marquee */

/**
 * The playing row's label marquee.
 *
 * The behaviour itself is in `marquee-engine.ts`, shared with the `Marquee` component; this is the
 * part that is specific to the list — which boxes belong to one clock. Title and artist are in the
 * same row, so they are animated together and leave and arrive together.
 */
export function useMarquee(tbodyRef: RefObject<HTMLTableSectionElement | null>, playingTrackId: string | null, rows: readonly Track[]): void {
  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || !playingTrackId) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    return runMarquee([...tbody.querySelectorAll<HTMLElement>('tr.is-playing .aqua-marquee')]);
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
  /** Build a queue of music like this one. Omitted where the product has no recommender. */
  onPlaySimilar?: ((track: Track) => void) | undefined;
  /** Save a copy of this track. Omitted where the product cannot reach its bytes. */
  onDownload?: ((track: Track) => void) | undefined;
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
export function RowMenu({ track, x, y, playlists, playlistItems, onTogglePlaylist, onNewPlaylist, onPlaySimilar, onDownload, onClose }: RowMenuProps) {
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
      {onPlaySimilar || onDownload ? <div className="ctx__sep" role="separator" /> : null}
      {onPlaySimilar ? (
        <button
          className="ctx__item"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onPlaySimilar(track);
          }}
        >
          Play similar to this
        </button>
      ) : null}
      {onDownload ? (
        <button
          className="ctx__item"
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onDownload(track);
          }}
        >
          Download…
        </button>
      ) : null}
    </div>
  );
}
