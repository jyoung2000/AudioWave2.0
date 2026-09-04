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
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
    // is a distraction, and re-rendering for it is waste.
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
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
}

/** The recessed pill, with the results popover pinned to its own edges. */
export function BarSearch({ value, onChange, placeholder = 'Search', label, results, open = false, onOpenChange, onSubmit }: BarSearchProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  useDismiss(wrapRef, open, () => onOpenChange?.(false));
  return (
    <div className="np-search" role="search" ref={wrapRef}>
      <svg className="np-search__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
        <circle cx="6.6" cy="6.6" r="4.4" stroke="currentColor" strokeWidth="2.2" />
        <path d="M10.1 10.1 L14 14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <input
        className="np-search__input"
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
          onOpenChange?.(event.target.value.trim().length > 0);
        }}
        onFocus={() => {
          if (value.trim()) onOpenChange?.(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onOpenChange?.(false);
            onChange('');
          } else if (event.key === 'Enter') {
            onSubmit?.(value);
          }
        }}
      />
      {open && results ? (
        <div id={listId} className="np-results">
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
  return (
    <div className="np-mode" role="radiogroup" aria-label={label}>
      {modes.map((mode, index) => {
        const checked = mode.id === value;
        const blocked = Boolean(mode.unavailableReason);
        return (
          <button
            key={mode.id}
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
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              const other = modes[index === 0 ? 1 : 0]!;
              if (other.unavailableReason) onBlocked?.(other.unavailableReason);
              else onChange(other.id);
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
