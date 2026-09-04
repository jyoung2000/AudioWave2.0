import { forwardRef, useCallback, useEffect, useId, useRef, useState, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useAqua } from '../context.js';
import { Button } from './Button.js';
import { Glyph } from '../icons/glyphs.js';

export interface AquaWindowProps extends HTMLAttributes<HTMLElement> {
  /** Overrides the tracked document-active state. */
  active?: boolean;
  /** Visible window title (hidden in the itunes-10 profile). */
  title?: string;
  /** Flush: no outer frame/shadow (when the app fills the browser viewport). */
  flush?: boolean;
  children: ReactNode;
}

/** One framed desktop-style window or clearly bounded app shell (spec §9.1). */
export const AquaWindow = forwardRef<HTMLElement, AquaWindowProps>(function AquaWindow({ active, title, flush, className, children, ...rest }, ref) {
  const ctx = useAqua();
  const isActive = active ?? ctx.active;
  return (
    <section ref={ref} className={['aqua-window', flush && 'aqua-window--flush', className].filter(Boolean).join(' ')} data-active={isActive ? 'true' : 'false'} data-aqua-profile={ctx.profile} aria-label={title} {...rest}>
      {title ? (
        <div className="aqua-window__title" aria-hidden="true">
          {title}
        </div>
      ) : null}
      {children}
    </section>
  );
});

export interface WorkAreaProps {
  /** The source list (nav). */
  sidebar: ReactNode;
  children: ReactNode;
  /** Current source name shown on the narrow-width source button. */
  currentSourceName: string;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  /** Extra content above the primary view (scope bar). */
  scope?: ReactNode;
  className?: string;
}

/**
 * Work area: source list | splitter | content. Below 760 px the source list becomes a drawer opened by a
 * source button that always shows the current source name (spec §8.3).
 */
export function WorkArea({ sidebar, children, currentSourceName, sidebarWidth, onSidebarWidthChange, minWidth = 160, maxWidth = 280, scope, className }: WorkAreaProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerState, setDrawerState] = useState<'entering' | 'open'>('open');
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const drawerId = useId();
  const [width, setWidth] = useState(sidebarWidth ?? 196);
  const currentWidth = sidebarWidth ?? width;
  const setW = useCallback(
    (w: number) => {
      const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(w)));
      setWidth(clamped);
      onSidebarWidthChange?.(clamped);
    },
    [minWidth, maxWidth, onSidebarWidthChange],
  );
  const openDrawer = () => {
    setDrawerState('entering');
    setDrawerOpen(true);
    requestAnimationFrame(() => setDrawerState('open'));
  };
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    openerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    const first = drawer?.querySelector<HTMLElement>('[tabindex="0"], button, a');
    first?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    // Selecting a source inside the drawer closes it (delegated so the sidebar stays a plain ReactNode).
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[role="option"], [role="treeitem"], a')) closeDrawer();
    };
    document.addEventListener('keydown', onKey);
    drawer?.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      drawer?.removeEventListener('click', onClick);
    };
  }, [drawerOpen, closeDrawer]);
  return (
    <div className={['aqua-work-area', className].filter(Boolean).join(' ')} style={{ '--aqua-sidebar-width': `${currentWidth}px` } as React.CSSProperties}>
      <div className="aqua-work-area__sidebar">{sidebar}</div>
      <div className="aqua-work-area__splitter">
        <Splitter value={currentWidth} min={minWidth} max={maxWidth} onChange={setW} label="Resize source list" />
      </div>
      <div className="aqua-work-area__content">
        <Button ref={openerRef} className="aqua-work-area__source-button" size="small" icon="disclosure-right" aria-haspopup="dialog" aria-expanded={drawerOpen} aria-controls={drawerId} onClick={openDrawer}>
          {currentSourceName}
        </Button>
        {scope}
        {children}
      </div>
      {drawerOpen ? (
        <>
          <button type="button" className="aqua-work-area__drawer-backdrop" onClick={closeDrawer} aria-label="Close sources" tabIndex={-1} style={{ border: 0, padding: 0 }} />
          <div id={drawerId} ref={drawerRef} className="aqua-work-area__drawer" data-state={drawerState} role="dialog" aria-modal="true" aria-label="Sources">
            {sidebar}
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface SplitterProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  wide?: boolean;
  step?: number;
}

/** role="separator" with keyboard resize; hit area wider than the hairline (spec §9.7). */
export function Splitter({ value, min, max, onChange, label, wide, step = 8 }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') onChange(Math.max(min, value - (e.shiftKey ? step * 4 : step)));
    else if (e.key === 'ArrowRight') onChange(Math.min(max, value + (e.shiftKey ? step * 4 : step)));
    else if (e.key === 'Home') onChange(min);
    else if (e.key === 'End') onChange(max);
    else return;
    e.preventDefault();
  };
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- a focusable separator is the ARIA window-splitter widget */
  return (
    <div
      className={['aqua-splitter', wide && 'aqua-splitter--wide'].filter(Boolean).join(' ')}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      data-dragging={dragging ? 'true' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startX.current = e.clientX;
        startW.current = value;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        onChange(Math.max(min, Math.min(max, startW.current + (e.clientX - startX.current))));
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
    />
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}

export function Content({ children, className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <main className={['aqua-content', className].filter(Boolean).join(' ')} tabIndex={-1} {...rest}>
      {children}
    </main>
  );
}

export interface BottomBarProps extends HTMLAttributes<HTMLElement> {
  left?: ReactNode;
  status?: ReactNode;
  right?: ReactNode;
  size?: 'small' | 'regular';
}

/** Subordinate actions + status (spec §9.12). The status is a polite live region. */
export function BottomBar({ left, status, right, size = 'small', className, ...rest }: BottomBarProps) {
  return (
    <footer className={['aqua-bottom-bar', size === 'regular' && 'aqua-bottom-bar--regular', className].filter(Boolean).join(' ')} {...rest}>
      <div className="aqua-bottom-bar__left">{left}</div>
      <div className="aqua-bottom-bar__center">
        <output className="aqua-bottom-bar__status" aria-live="polite">
          {status}
        </output>
      </div>
      <div className="aqua-bottom-bar__right">{right}</div>
    </footer>
  );
}

export function DisclosureGlyph({ open }: { open: boolean }) {
  return <Glyph name={open ? 'disclosure-down' : 'disclosure-right'} />;
}
