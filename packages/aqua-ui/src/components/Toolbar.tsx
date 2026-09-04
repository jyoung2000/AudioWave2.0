import type { HTMLAttributes, ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';

export interface ToolbarProps extends HTMLAttributes<HTMLElement> {
  windowControls?: ReactNode;
  transport?: ReactNode;
  display?: ReactNode;
  secondary?: ReactNode;
  search?: ReactNode;
  /** Optional second row (narrow widths: the search pill moves here). */
  extra?: ReactNode;
}

/** Unified titlebar/toolbar (spec §9.2): controls | transport | display | secondary | search. */
export function Toolbar({ windowControls, transport, display, secondary, search, extra, className, ...rest }: ToolbarProps) {
  return (
    <header className={['aqua-toolbar', className].filter(Boolean).join(' ')} {...rest}>
      <div className="aqua-toolbar__controls">{windowControls}</div>
      <div className="aqua-toolbar__transport">{transport}</div>
      <div className="aqua-toolbar__display">{display}</div>
      <div className="aqua-toolbar__secondary">{secondary}</div>
      <div className="aqua-toolbar__search">{search}</div>
      {extra ? <div className="aqua-toolbar__extra">{extra}</div> : null}
    </header>
  );
}

export interface TrafficLightsProps {
  /** When handlers are provided the lights are real buttons with names and tooltips; otherwise decorative. */
  onClose?: () => void;
  onMinimize?: () => void;
  onZoom?: () => void;
}

/** Horizontal red/yellow/green in the default profile (vertical only under itunes-10) (spec §9.3). */
export function TrafficLights({ onClose, onMinimize, onZoom }: TrafficLightsProps) {
  const functional = Boolean(onClose || onMinimize || onZoom);
  if (!functional) {
    return (
      <span className="aqua-traffic" aria-hidden="true">
        <span className="aqua-traffic__light" data-kind="close" />
        <span className="aqua-traffic__light" data-kind="minimize" />
        <span className="aqua-traffic__light" data-kind="zoom" />
      </span>
    );
  }
  const light = (kind: 'close' | 'minimize' | 'zoom', label: string, onClick: (() => void) | undefined, glyph: 'close' | 'minimize' | 'zoom') => (
    <span className="aqua-traffic__hit">
      <button type="button" className="aqua-traffic__light" data-kind={kind} aria-label={label} title={label} onClick={onClick} disabled={!onClick}>
        <span className="aqua-traffic__glyph">
          <Glyph name={glyph} />
        </span>
      </button>
    </span>
  );
  return (
    <span className="aqua-traffic" role="group" aria-label="Window controls">
      {light('close', 'Close', onClose, 'close')}
      {light('minimize', 'Minimize', onMinimize, 'minimize')}
      {light('zoom', 'Zoom', onZoom, 'zoom')}
    </span>
  );
}
