import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';
import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';

export type StateKind = 'empty' | 'loading' | 'partial' | 'offline' | 'error' | 'permission' | 'incompatible' | 'unavailable' | 'warning' | 'info';

export interface StateAction {
  id: string;
  label: string;
  onSelect: () => void;
  variant?: 'neutral' | 'default' | 'destructive';
  busy?: boolean;
}

export interface StatePanelProps {
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

const DEFAULT_ICONS: Record<StateKind, GlyphName> = { empty: 'note', loading: 'refresh', partial: 'warning', offline: 'offline', error: 'error', permission: 'lock', incompatible: 'warning', unavailable: 'info', warning: 'warning', info: 'info' };

/** Shared state panel: same material and type system for empty/loading/partial/offline/error/permission/incompatible/unavailable. */
export function StatePanel({ kind, title, text, icon, actions, progress, details, inline, className }: StatePanelProps) {
  return (
    <div className={['aqua-state', inline && 'aqua-state--inline', className].filter(Boolean).join(' ')} data-kind={kind} role={kind === 'error' ? 'alert' : kind === 'loading' ? 'status' : 'group'} aria-label={title}>
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
export const PartialState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="partial" {...p} />;
export const OfflineState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="offline" {...p} />;
export const ErrorState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="error" {...p} />;
export const PermissionRequiredState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="permission" {...p} />;
export const IncompatibleVersionState = (p: Omit<StatePanelProps, 'kind'>) => <StatePanel kind="incompatible" {...p} />;

/** "Why unavailable?" disclosure for capability-gated actions. */
export function UnavailableCapabilityState({ title, reason, ...rest }: Omit<StatePanelProps, 'kind' | 'details'> & { reason: string }) {
  return <StatePanel kind="unavailable" title={title} details={{ summary: 'Why unavailable?', text: reason }} {...rest} />;
}

/** Small status dot + label (never colour alone: the label carries the state). */
export function StatusDot({ kind, label }: { kind: 'ok' | 'warning' | 'error' | 'info' | 'neutral'; label: string }) {
  return (
    <span>
      <span className="aqua-status-dot" data-kind={kind === 'neutral' ? undefined : kind} aria-hidden="true" />
      {label}
    </span>
  );
}
