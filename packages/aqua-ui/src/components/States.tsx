import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';
import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';

/** The two states a library view draws as a panel; every other answer is the view's own words. */
type StateKind = 'empty' | 'loading';

interface StateAction {
  id: string;
  label: string;
  onSelect: () => void;
  variant?: 'neutral' | 'default' | 'destructive';
  busy?: boolean;
}

interface StatePanelProps {
  kind: StateKind;
  title: string;
  text?: ReactNode;
  icon?: GlyphName;
  actions?: StateAction[];
  /** Determinate/indeterminate progress for loading states. */
  progress?: { value?: number | null; label: string };
  /** Expandable detail (e.g. the raw provider reason). */
  details?: { summary: string; text: string };
  inline?: boolean;
  className?: string;
}

const DEFAULT_ICONS: Record<StateKind, GlyphName> = { empty: 'note', loading: 'refresh' };

/** Shared state panel: one material and type system for the empty and loading states below. */
function StatePanel({ kind, title, text, icon, actions, progress, details, inline, className }: StatePanelProps) {
  return (
    <div className={['aqua-state', inline && 'aqua-state--inline', className].filter(Boolean).join(' ')} data-kind={kind} role={kind === 'loading' ? 'status' : 'group'} aria-label={title}>
      <span className="aqua-state__icon" aria-hidden="true">
        <Glyph name={icon ?? DEFAULT_ICONS[kind]} />
      </span>
      <h3 className="aqua-state__title">{title}</h3>
      {text ? <p className="aqua-state__text">{text}</p> : null}
      {progress ? <ProgressBar className="aqua-state__progress" value={progress.value} label={progress.label} /> : null}
      {actions?.length ? (
        <div className="aqua-state__actions">
          {actions.map((a) => (
            <Button key={a.id} variant={a.variant ?? 'neutral'} onClick={a.onSelect} busy={a.busy}>
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}
      {details ? (
        <details className="aqua-state__details">
          <summary>{details.summary}</summary>
          <p>{details.text}</p>
        </details>
      ) : null}
    </div>
  );
}

export const EmptyState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="empty" {...p} />;
export const LoadingState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="loading" {...p} />;

/** Small status dot + label (never colour alone: the label carries the state). */
export function StatusDot({ kind, label }: { kind: 'ok' | 'warning' | 'error' | 'info' | 'neutral'; label: string }) {
  return (
    <span>
      <span className="aqua-status-dot" data-kind={kind === 'neutral' ? undefined : kind} aria-hidden="true" />
      {label}
    </span>
  );
}
