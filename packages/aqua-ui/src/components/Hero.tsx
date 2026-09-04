/**
 * The hero: the song, always at the top of the page.
 *
 * In the old shell the transport lived in a toolbar and "Now playing" was a *place you went*. The
 * reference argues the other way — the record and its controls are the page, and everything else is
 * a list underneath. That is right for a music player, and it is the only arrangement that works on
 * a phone without a second navigation step to reach the pause button.
 *
 * Every measurement here is from `docs/reference/now-playing-header.html`, which took them from
 * photographs of the hardware. The scrubber in particular is deliberately absent from every media
 * query: identical groove, gel and stamps at each width, as on the device.
 */
import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';

export interface HeroProps {
  /** Drives the placeholder sleeve wash; 'shared' turns it from amber to deep blue. */
  mode?: 'solo' | 'shared';
  children: ReactNode;
  className?: string;
}

export function Hero({ mode = 'solo', children, className }: HeroProps) {
  const inner = useRef<HTMLDivElement | null>(null);
  /*
   * Keep the transport row's right edge under the progress rail's right edge.
   *
   * The rail is the element that absorbs whatever the row beside it is doing, so measuring it
   * catches every case — a mode change swapping the duration stamp for the LIVE marker, a font
   * arriving late, a width change — where hard-coding a padding would not. A layout effect rather
   * than a paint-time one: the number is a margin, and reading it after the browser has drawn
   * would show a frame of the volume slider in the wrong place.
   */
  const observer = useRef<ResizeObserver | null>(null);
  const watched = useRef<Element | null>(null);
  const align = useCallback((): void => {
    const host = inner.current;
    if (!host) return;
    const rail = host.querySelector('.np-scrub__rail');
    // The rail comes and goes with the view, so the observer follows whichever one is mounted now.
    if (rail !== watched.current) {
      if (watched.current) observer.current?.unobserve(watched.current);
      if (rail) observer.current?.observe(rail);
      watched.current = rail;
    }
    if (!rail) {
      host.style.removeProperty('--np-track-inset-r');
      return;
    }
    const box = host.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const pad = Number.parseFloat(getComputedStyle(host).paddingRight) || 0;
    host.style.setProperty('--np-track-inset-r', `${Math.max(0, box.right - pad - railBox.right).toFixed(1)}px`);
  }, []);
  useLayoutEffect(() => {
    const host = inner.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const next = new ResizeObserver(() => align());
    observer.current = next;
    next.observe(host);
    align();
    return () => {
      next.disconnect();
      observer.current = null;
      watched.current = null;
    };
  }, [align]);
  // Every render, because the rail may have just appeared, gone, or changed what sits beside it.
  useLayoutEffect(align);
  return (
    <section className={['np-hero', className].filter(Boolean).join(' ')} data-mode={mode} aria-label="Now playing">
      <div ref={inner} className="np-hero__inner">
        {children}
      </div>
    </section>
  );
}

export interface HeroArtProps {
  src?: string | null;
  /** Shown to screen readers; artwork is decorative when the title is beside it. */
  alt?: string;
  /** The stage element, for a 3D renderer to mount into over the flat cover. */
  stageRef?: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
}

export function HeroArt({ src, alt = '', stageRef, children }: HeroArtProps) {
  return (
    <div className="np-hero__art">
      <div ref={stageRef} className={['np-hero__stage', src ? null : 'np-hero__stage--empty'].filter(Boolean).join(' ')}>
        {src ? (
          <img src={src} alt={alt} />
        ) : (
          // A note over a dimmed sleeve wash, rather than a saturated block that would read as
          // cover art this track does not have.
          <svg className="np-hero__placeholder" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z" />
          </svg>
        )}
        {children}
      </div>
    </div>
  );
}

export interface TrackScrubberProps {
  positionMs: number;
  /**
   * Null while the browser has not reported a duration yet.
   *
   * Kept nullable rather than defaulted to zero: an unknown length is a real state — a stream, or a
   * file still loading its header — and a bar that cannot say where the end is should not draw one.
   */
  durationMs: number | null;
  onSeek: (ms: number) => void;
  disabled?: boolean;
  /** Replaces the right-hand stamp with the LIVE marker and makes the rail read-only. */
  live?: boolean;
  /** Why seeking is refused, said out loud rather than swallowed. */
  disabledReason?: string;
  /** Space, while the rail has focus. Optional: without it the key simply does nothing. */
  onTogglePlay?: () => void;
  label?: string;
}

/**
 * The iPod 5G scrubber: a 12 px well, a fill that brightens downward, stamps beneath the ends, and
 * no knob — the device had none, and a knob on a 12 px bar is a thumb-sized lie about precision.
 */
export function TrackScrubber({ positionMs, durationMs, onSeek, disabled, live, disabledReason, onTogglePlay, label = 'Playback position' }: TrackScrubberProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const length = durationMs ?? 0;
  const inert = Boolean(disabled || live || length <= 0);
  // A broadcast is always at its own live edge: there is no remaining time to draw, so the rail is
  // full rather than showing a position that would imply somewhere else to drag it to.
  const fraction = live ? 1 : length > 0 ? Math.min(1, Math.max(0, positionMs / length)) : 0;

  const seekTo = useCallback(
    (event: { clientX: number }) => {
      const rail = railRef.current;
      if (!rail || inert) return;
      const rect = rail.getBoundingClientRect();
      const next = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      onSeek(next * length);
    },
    [length, inert, onSeek],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (inert || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    seekTo(event);
  };

  return (
    <div className="np-scrub">
      <div
        ref={railRef}
        className={['np-scrub__rail', live ? 'is-live' : null].filter(Boolean).join(' ')}
        /*
         * A rail that cannot be moved is not a slider. Announcing one anyway offers a screen-reader
         * user a value to change and then refuses every attempt, so a broadcast drops the role and
         * the value pair and reads as what it is: a picture of how far in the stream has run.
         */
        role={live ? 'img' : 'slider'}
        tabIndex={inert ? -1 : 0}
        aria-label={live ? `Live broadcast, ${formatClock(positionMs)} elapsed` : label}
        {...(live
          ? {}
          : {
              'aria-valuemin': 0,
              'aria-valuemax': Math.round(length / 1000),
              'aria-valuenow': Math.round(positionMs / 1000),
              'aria-valuetext': length > 0 ? `${formatClock(positionMs)} of ${formatClock(length)}` : `${formatClock(positionMs)}, length unknown`,
            })}
        aria-disabled={inert || undefined}
        title={inert ? disabledReason : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (dragging.current) seekTo(event);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          if (inert) return;
          // 5 s a press, 15 s with Shift; up and down work as well as left and right, because on a
          // horizontal bar people reach for both. Space is play/pause here as it is everywhere
          // else, so the focus ring sitting on the rail does not take the shortcut away.
          const step = event.shiftKey ? 15_000 : 5000;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onSeek(Math.min(length, positionMs + step));
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onSeek(Math.max(0, positionMs - step));
          else if (event.key === 'Home') onSeek(0);
          else if (event.key === 'End') onSeek(length);
          else if (event.key === ' ') onTogglePlay?.();
          else return;
          event.preventDefault();
        }}
      >
        <div className="np-scrub__fill" style={{ width: `calc(${(fraction * 100).toFixed(3)}% - 2px)` }} />
      </div>
      <div className="np-scrub__stamps">
        <span className="np-scrub__time">{formatClock(positionMs)}</span>
        {live ? (
          <span className="np-live">
            <span className="np-live__dot" aria-hidden="true" />
            LIVE
          </span>
        ) : (
          <span className="np-scrub__time">{length > 0 ? `-${formatClock(Math.max(0, length - positionMs))}` : '--:--'}</span>
        )}
      </div>
    </div>
  );
}

function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(hours ? minutes : minutes).padStart(2, '0');
  return hours ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}` : `${mm}:${String(seconds).padStart(2, '0')}`;
}

/* --------------------------------------------------------------------------
   Transport keys. The glyphs are the reference's own — an iPod's previous key
   is a bar and two triangles, not a mirrored "next", and at 26 px the
   difference is the difference between reading as a device and reading as a
   web page.
   -------------------------------------------------------------------------- */

const KEY_GLYPHS = {
  play: <path d="M7.4 4.8 19 12 7.4 19.2z" />,
  pause: <path d="M7.1 5.2h3.5v13.6H7.1zM13.4 5.2h3.5v13.6h-3.5z" />,
  previous: (
    <>
      <path d="M4 6.6h2.1v10.8H4z" />
      <path d="M13.4 6.6v10.8L6.6 12z" />
      <path d="M20.6 6.6v10.8L13.8 12z" />
    </>
  ),
  next: (
    <>
      <path d="M3.4 6.6 10.2 12 3.4 17.4z" />
      <path d="M10.6 6.6 17.4 12l-6.8 5.4z" />
      <path d="M17.9 6.6H20v10.8h-2.1z" />
    </>
  ),
  /*
   * Repeat: two bars with solid arrowheads, not a stroked loop.
   *
   * The library's toolbar glyph is drawn for 13 px and the reference's is drawn as thin strokes;
   * at the 22 px aux key both collapse into a rounded pill, because the loop's two long sides end
   * up closer together than the stroke is wide. Solid bars with the arrowheads clear of the corners
   * survive the size.
   */
  repeat: (
    <>
      <path d="M6 7h10v2H8v3H6z" />
      <path d="M16 4.6 20.6 8 16 11.4z" />
      <path d="M18 17H8v-2h8v-3h2z" />
      <path d="M8 12.6 3.4 16 8 19.4z" />
    </>
  ),
  'repeat-one': (
    <>
      <path d="M6 7h10v2H8v3H6z" />
      <path d="M16 4.6 20.6 8 16 11.4z" />
      <path d="M18 17H8v-2h8v-3h2z" />
      <path d="M8 12.6 3.4 16 8 19.4z" />
      <path d="M11.2 10.3h1.5v3.4h-1.6v-2.2l-.9.4v-1.2z" />
    </>
  ),
} as const;

export type TransportKeyGlyph = keyof typeof KEY_GLYPHS;

export interface KeyButtonProps {
  label: string;
  glyph?: TransportKeyGlyph;
  children?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Auxiliary keys sit muted beside the primary cluster. */
  aux?: boolean;
  primary?: boolean;
  title?: string;
}

export function KeyButton({ label, glyph, children, onClick, disabled, pressed, aux, primary, title }: KeyButtonProps) {
  return (
    <button
      type="button"
      className={['np-key', aux && 'np-key--aux', primary && 'np-key--play'].filter(Boolean).join(' ')}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {glyph ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {KEY_GLYPHS[glyph]}
        </svg>
      ) : (
        children
      )}
    </button>
  );
}

export interface KeyTransportProps {
  children: ReactNode;
  volume?: ReactNode;
  label?: string;
  /** Why the whole row is inert (a live broadcast, an empty queue). */
  disabledReason?: string;
}

/** The chromeless key row: no slab behind the glyphs, and the volume line pinned right. */
export function KeyTransport({ children, volume, label = 'Playback controls', disabledReason }: KeyTransportProps) {
  return (
    <div className="np-transport" role="group" aria-label={label} title={disabledReason}>
      <div className="np-transport__keys">{children}</div>
      {volume}
    </div>
  );
}

export interface LevelSliderProps {
  value: number;
  onChange: (value: number) => void;
  muted?: boolean;
  onToggleMute?: () => void;
  label?: string;
}

/** The 122 px volume line with the gel knob, and a mute toggle on the speaker at its left. */
export function LevelSlider({ value, onChange, muted, onToggleMute, label = 'Volume' }: LevelSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const percent = Math.round((muted ? 0 : value) * 100);
  const set = (event: { clientX: number }): void => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)));
  };
  return (
    <div className="np-vol">
      <button type="button" className="np-vol__btn" aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} aria-pressed={Boolean(muted)} onClick={onToggleMute}>
        <svg className="np-vol__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M2 6.2h2.6L7.8 3.4v9.2L4.6 9.8H2z" />
          {muted ? <path d="M10.2 5.9 11.5 7.2l1.3-1.3.9.9-1.3 1.3 1.3 1.3-.9.9-1.3-1.3-1.3 1.3-.9-.9L10.6 8.1 9.3 6.8z" /> : null}
        </svg>
      </button>
      <div
        ref={trackRef}
        className="np-vol__track"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={muted ? 'Muted' : `${percent}%`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          set(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) set(event);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(event) => {
          // 4% a press, 10% with Shift — the reference's steps. Small enough to trim a level,
          // large enough that crossing the whole line is a handful of presses rather than fifty.
          const step = event.shiftKey ? 0.1 : 0.04;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onChange(Math.min(1, value + step));
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onChange(Math.max(0, value - step));
          else if (event.key === 'Home') onChange(0);
          else if (event.key === 'End') onChange(1);
          else return;
          event.preventDefault();
        }}
      >
        <div className="np-vol__fill" style={{ width: `${percent}%` }} />
        <div className="np-vol__knob" style={{ left: `${percent}%` }} />
      </div>
      <svg className="np-vol__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M1 6.2h2.6L6.8 3.4v9.2L3.6 9.8H1z" />
        <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M9.4 5.6a3.3 3.3 0 0 1 0 4.8" />
          <path d="M11.6 3.6a6.2 6.2 0 0 1 0 8.8" />
        </g>
      </svg>
    </div>
  );
}
