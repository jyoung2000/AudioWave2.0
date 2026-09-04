/**
 * Pieces shared by the admin views.
 *
 * `AsyncPanel` is the important one: it standardises what a panel does while loading, when it
 * fails, and when it succeeds but has nothing to show. Every view uses it, so "empty" never looks
 * like "broken" and a failure always names the correlation id an operator can grep for.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, EmptyState, ErrorState, LoadingState, Panel, StatusDot } from '@now-playing/aqua-ui';
import type { ApiError } from '../lib/api.js';
import type { Resource } from '../lib/hooks.js';

export function AsyncPanel<T>({
  resource,
  title,
  emptyWhen,
  emptyTitle,
  emptyText,
  actions,
  children,
}: {
  resource: Resource<T>;
  title?: string;
  emptyWhen?: (data: T) => boolean;
  emptyTitle?: string;
  emptyText?: string;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const body = (() => {
    if (resource.error) return <ApiErrorState error={resource.error} onRetry={resource.reload} />;
    if (resource.initial && resource.loading) return <LoadingState title="Loading" />;
    if (!resource.data) return <EmptyState title={emptyTitle ?? 'Nothing here yet'} {...(emptyText ? { text: emptyText } : {})} />;
    if (emptyWhen?.(resource.data)) return <EmptyState title={emptyTitle ?? 'Nothing here yet'} {...(emptyText ? { text: emptyText } : {})} />;
    return children(resource.data);
  })();

  return (
    <Panel {...(title ? { title } : {})}>
      {actions ? <div className="admin-actions">{actions}</div> : null}
      {body}
    </Panel>
  );
}

export function ApiErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <ErrorState
      title={error.status === 0 ? 'Cannot reach the hub' : 'That did not work'}
      text={error.message}
      {...(error.correlationId ? { details: { summary: 'Technical detail', text: `Correlation id ${error.correlationId} — search Diagnostics → Logs for this to see what happened.` } } : {})}
      {...(onRetry ? { actions: [{ id: 'retry', label: 'Try again', onSelect: onRetry, variant: 'default' as const }] } : {})}
    />
  );
}

/** Inline error under a form, with the correlation id when the hub gave one. */
export function InlineError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p className="admin-inline-error" role="alert">
      {error.message}
      {error.correlationId ? <span className="admin-inline-error__id"> ({error.correlationId.slice(0, 8)})</span> : null}
    </p>
  );
}

export function Health({ status }: { status: string }) {
  const kind = status === 'ok' ? 'ok' : status === 'degraded' || status === 'unconfigured' ? 'warning' : status === 'down' ? 'error' : 'neutral';
  return <StatusDot kind={kind} label={status} />;
}

export function Bytes({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <>—</>;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return <>{`${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`}</>;
}

/**
 * A clock that ticks once a minute, shared by every relative timestamp on screen.
 *
 * Reading `Date.now()` during render would be impure — the value would differ between renders for
 * no reason a component controls, and, worse, "3 min ago" would stay "3 min ago" until something
 * else happened to re-render it. One interval keeps every timestamp honest and costs one render a
 * minute.
 */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Ago({ iso }: { iso: string | null | undefined }) {
  const now = useNow();
  if (!iso) return <>never</>;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return <>{iso}</>;
  const seconds = Math.round((now - parsed) / 1000);
  if (seconds < 0) return <>{new Date(parsed).toLocaleString()}</>;
  if (seconds < 60) return <>just now</>;
  if (seconds < 3600) return <>{`${Math.round(seconds / 60)} min ago`}</>;
  if (seconds < 86400) return <>{`${Math.round(seconds / 3600)} h ago`}</>;
  return <>{new Date(parsed).toLocaleDateString()}</>;
}

export function Duration({ ms }: { ms: number | null | undefined }) {
  if (!ms || ms <= 0) return <>—</>;
  const total = Math.round(ms / 1000);
  return <>{`${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`}</>;
}

/** A destructive action that asks first, in the Aqua idiom (a verb, not "OK"). */
export function ConfirmButton({ label, confirmLabel, onConfirm, busy, danger = true }: { label: string; confirmLabel: string; onConfirm: () => void; busy?: boolean; danger?: boolean }) {
  return (
    <Button
      size="small"
      variant={danger ? 'destructive' : 'neutral'}
      busy={busy}
      // A native confirm is the honest, keyboard-accessible minimum for a destructive action.
      onClick={() => {
        if (window.confirm(confirmLabel)) onConfirm();
      }}
    >
      {label}
    </Button>
  );
}
