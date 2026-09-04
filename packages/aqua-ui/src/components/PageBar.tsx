/**
 * The status bar: the app's only chrome.
 *
 * The reference (`docs/reference/now-playing-header.html`) replaces the whole window frame with one
 * sticky bar — a label, a recessed search pill, and a right-hand cluster of listening mode, clock
 * and profile. Everything else on the page is content. That is a 2010 arrangement rather than a
 * 2009 one, and it is the arrangement a phone can actually use.
 *
 * The grid deliberately gives the two side columns equal minimum widths, so the pill is optically
 * centred *in the bar* rather than centred in whatever space the two ends happen to leave.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useDismiss } from '../hooks/index.js';

export interface PageBarProps {
  /** The wordmark at the left. */
  label: string;
  search?: ReactNode;
  /** Listening mode, clock, profile — anything right-aligned. */
  status?: ReactNode;
  className?: string;
}

export function PageBar({ label, search, status, className }: PageBarProps) {
  return (
    <header className={['np-bar', className].filter(Boolean).join(' ')}>
      <div className="np-bar__inner">
        <span className="np-bar__label">{label}</span>
        {search}
        <div className="np-bar__status">{status}</div>
      </div>
    </header>
  );
}

/** A wall clock, because the reference has one and a full-bleed player has no other chrome to carry it. */
export function BarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Tick on the minute rather than the second: a clock that changes 60 times a minute in a corner
    // is a distraction, and re-rendering for it is waste. But it has to change *on* the minute, so
    // the timeout is re-armed to the next boundary each time rather than run at a fixed interval —
    // a poll lands up to its own period late, and a throttled background tab lands later still.
    let timer = 0;
    const sync = (): void => {
      window.clearTimeout(timer);
      const at = new Date();
      setNow(at);
      const untilNextMinute = 60_000 - (at.getSeconds() * 1000 + at.getMilliseconds());
      timer = window.setTimeout(sync, untilNextMinute + 20);
    };
    sync();
    // Waking the tab is the case a fixed interval gets wrong: the timer was frozen, so the reading
    // on screen is stale the instant it comes back.
    const wake = (): void => {
      if (!document.hidden) sync();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', sync);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', sync);
    };
  }, []);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return (
    <time className="np-bar__clock" dateTime={`${hours}:${minutes}`}>
      {`${hours}:${minutes}`}
    </time>
  );
}

export interface BarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  /** Rendered under the pill when open; supply the results popover. */
  results?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSubmit?: (value: string) => void;
  /**
   * The arrow keys and Return, handed to whatever is rendered in `results`.
   *
   * Focus stays in the field — this is a combobox, and its listbox is pointed at with
   * `aria-activedescendant` rather than by moving the focus ring into it. That is why the keys are
   * routed out of here instead of being handled where the rows are.
   */
  onArrow?: (delta: 1 | -1) => void;
  /** PageDown / PageUp, for a results list that pages. */
  onPage?: (delta: 1 | -1) => void;
  onCommit?: () => void;
  activeDescendant?: string | null;
  /** The id of the listbox inside `results`, for `aria-controls`. */
  controls?: string;
  /** The field itself, so whatever closes the popover can put the caret back in it. */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/** The recessed pill, with the results popover pinned to its own edges. */
export function BarSearch({ value, onChange, placeholder = 'Search', label, results, open = false, onOpenChange, onSubmit, onArrow, onPage, onCommit, activeDescendant, controls, inputRef }: BarSearchProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  useDismiss(wrapRef, open, () => onOpenChange?.(false));
  /*
   * Pressing inside the popover must not pull the focus out of the field: this is a combobox, the
   * rows are pointed at with aria-activedescendant, and a blur here would both drop that pointer
   * and close the list out from under the press. Links keep their own behaviour, since following
   * one is meant to leave.
   *
   * Attached to the node rather than written as a JSX handler because the popover is a container,
   * not a control — it has no role of its own, and giving it one to satisfy a handler would put a
   * meaningless element in the accessibility tree.
   */
  useEffect(() => {
    const node = popRef.current;
    if (!open || !node) return;
    const hold = (event: MouseEvent): void => {
      if (!(event.target as HTMLElement).closest('a')) event.preventDefault();
    };
    node.addEventListener('mousedown', hold);
    return () => node.removeEventListener('mousedown', hold);
  }, [open]);
  return (
    <div className="np-search" role="search" ref={wrapRef}>
      <svg className="np-search__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
        <circle cx="6.6" cy="6.6" r="4.4" stroke="currentColor" strokeWidth="2.2" />
        <path d="M10.1 10.1 L14 14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        className="np-search__input"
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={controls ?? listId}
        aria-autocomplete="list"
        {...(open && activeDescendant ? { 'aria-activedescendant': activeDescendant } : {})}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
          onOpenChange?.(event.target.value.trim().length > 0);
        }}
        onFocus={() => {
          if (value.trim()) onOpenChange?.(true);
        }}
        // Clicking a field that already has the focus fires no focus event, so a popover dismissed
        // with Escape would have no way back without this.
        onClick={() => {
          if (value.trim()) onOpenChange?.(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Close, but keep what was typed: Escape means "put this list away", and throwing the
            // query out with it costs a retype for nothing.
            if (open) {
              event.preventDefault();
              onOpenChange?.(false);
            }
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!open) {
              // The first arrow after a dismissal brings the list back rather than being swallowed.
              if (value.trim()) {
                event.preventDefault();
                onOpenChange?.(true);
              }
              return;
            }
            event.preventDefault();
            onArrow?.(event.key === 'ArrowDown' ? 1 : -1);
          } else if ((event.key === 'PageDown' || event.key === 'PageUp') && open) {
            event.preventDefault();
            onPage?.(event.key === 'PageDown' ? 1 : -1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            // A row under the arrows wins; otherwise Return means "show me everything".
            if (open && onCommit) onCommit();
            else onSubmit?.(value);
          }
        }}
      />
      {open && results ? (
        // `.srch` is the reference's own popover: its markup, its classes, its stylesheet block.
        <div id={listId} className="srch" ref={popRef}>
          {results}
        </div>
      ) : (
        <div id={listId} hidden />
      )}
    </div>
  );
}

export interface ListeningMode {
  id: string;
  label: string;
  /** Null when the mode is available; a sentence explaining the block when it is not. */
  unavailableReason?: string | null;
}

export interface ModeSwitchProps {
  modes: [ListeningMode, ListeningMode];
  value: string;
  onChange: (id: string) => void;
  /** Called instead of onChange when the chosen mode is unavailable, with the reason. */
  onBlocked?: (reason: string) => void;
  label?: string;
}

/**
 * Solo or shared, as an iOS 5 segmented control.
 *
 * The silhouettes are the reference's: the group mark is the same figure at k = 0.85 with two at
 * k = 0.62 behind it, and a mask cuts a gap around the front one so three same-coloured shapes do
 * not merge into a blob at 14 px.
 *
 * An unavailable mode stays *visible* and reports why when pressed, rather than disappearing. A
 * control that vanishes teaches nothing; one that explains itself does.
 */
export function ModeSwitch({ modes, value, onChange, onBlocked, label = 'Listening mode' }: ModeSwitchProps) {
  const maskId = useId().replace(/:/g, '');
  // The roving tab stop moves with the selection, so the key that moved it has to carry the focus
  // ring across too — otherwise the ring is left on a segment that is no longer tabbable and the
  // next Tab escapes the group from nowhere.
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="np-mode" role="radiogroup" aria-label={label}>
      {modes.map((mode, index) => {
        const checked = mode.id === value;
        const blocked = Boolean(mode.unavailableReason);
        return (
          <button
            key={mode.id}
            ref={(node) => {
              items.current[index] = node;
            }}
            type="button"
            className="np-mode__item"
            role="radio"
            aria-checked={checked}
            aria-disabled={blocked || undefined}
            aria-label={blocked ? `${mode.label} — ${mode.unavailableReason}` : mode.label}
            title={mode.unavailableReason ?? mode.label}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (blocked) onBlocked?.(mode.unavailableReason!);
              else onChange(mode.id);
            }}
            onKeyDown={(event) => {
              // A native segmented control's key model: one tab stop for the group, the arrows
              // move between segments in both axes, Home/End jump to the ends, and Space/Return
              // re-commit the segment already under the focus ring.
              const last = modes.length - 1;
              let next: number;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % modes.length;
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + modes.length) % modes.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = last;
              else if (event.key === ' ' || event.key === 'Enter') next = index;
              else return;
              event.preventDefault();
              const target = modes[next]!;
              items.current[next]?.focus();
              if (target.unavailableReason) onBlocked?.(target.unavailableReason);
              else onChange(target.id);
            }}
          >
            {index === 0 ? <SoloMark /> : <GroupMark maskId={maskId} />}
          </button>
        );
      })}
    </div>
  );
}

function SoloMark() {
  return (
    <svg viewBox="0 0 30 20" aria-hidden="true" focusable="false">
      <circle cx="15" cy="7.5" r="3.5" />
      <path d="M7.5 20C7.5 15.3 10.8 13 15 13s7.5 2.3 7.5 7z" />
    </svg>
  );
}

function GroupMark({ maskId }: { maskId: string }) {
  return (
    <svg viewBox="0 0 30 20" aria-hidden="true" focusable="false">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="30" height="20">
          <rect width="30" height="20" fill="#fff" />
          <g fill="#000" stroke="#000" strokeWidth="2.8" strokeLinejoin="round">
            <circle cx="15" cy="9.375" r="2.975" />
            <path d="M8.625 20C8.625 16.005 11.43 14.05 15 14.05s6.375 1.955 6.375 5.95z" />
          </g>
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <circle cx="6" cy="11.25" r="2.17" />
        <path d="M1.35 19C1.35 16.086 3.396 14.66 6 14.66s4.65 1.426 4.65 4.34z" />
        <circle cx="24" cy="11.25" r="2.17" />
        <path d="M19.35 19c0-2.914 2.046-4.34 4.65-4.34s4.65 1.426 4.65 4.34z" />
      </g>
      <circle cx="15" cy="9.375" r="2.975" />
      <path d="M8.625 20C8.625 16.005 11.43 14.05 15 14.05s6.375 1.955 6.375 5.95z" />
    </svg>
  );
}

export interface ProfileButtonProps {
  label: string;
  onClick?: () => void;
  expanded?: boolean;
  /** Tints the silhouette; used to distinguish members in a shared session. */
  hue?: number;
}

/** The white gel disc with a clipped silhouette, from the reference's right-hand cluster. */
export function ProfileButton({ label, onClick, expanded, hue = 212 }: ProfileButtonProps) {
  const id = useId().replace(/:/g, '');
  return (
    <button type="button" className="np-avatar" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={expanded} onClick={onClick}>
      <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`np-av-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={`hsl(${hue} 42% 62%)`} />
            <stop offset="1" stopColor={`hsl(${hue} 46% 44%)`} />
          </linearGradient>
          <clipPath id={`np-avc-${id}`}>
            <circle cx="20" cy="20" r="20" />
          </clipPath>
        </defs>
        <g clipPath={`url(#np-avc-${id})`} fill={`url(#np-av-${id})`}>
          <circle cx="20" cy="15" r="7" />
          <path d="M5 40 C5 30.6 11.6 26 20 26 C28.4 26 35 30.6 35 40 Z" />
        </g>
      </svg>
    </button>
  );
}
