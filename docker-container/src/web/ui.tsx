/**
 * The Airwave Hub window kit, in React.
 *
 * Every piece here renders the markup `design/frontends/origin/airwave-hub.html` uses, with the class
 * names its stylesheets (`@now-playing/aqua-ui/airwave-window.css` and `airwave-hub.css`) style:
 * `.push` buttons, `.field` inputs, `.pop` pop-ups, `.chk` checkboxes, `.well` list boxes, `.rows`,
 * `.tbl`, `.sdot`, `.kv`. Nothing here invents a look; it only saves each view from repeating the
 * same markup and gives loading, empty and failed states one quiet shape (a line inside the list
 * box, never an illustration).
 *
 * The drawings these controls wear are shared (`@now-playing/aqua-ui/airwave-art`), and so are the
 * stylesheets. The components stay here: the companion's kit writes the same classes but not the
 * same markup or props (its sheet is a `<dialog>`, its checkbox passes input props through, its
 * pop-up takes an options list), so one shared component would change what one of the two renders.
 * design/decisions.md DEC-026 records that, and the styleguide draws both.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import type { ApiError } from './lib/api.js';
import type { Resource } from './lib/hooks.js';

/* ------------------------------------------------------------------ words */

/** What went wrong, as one sentence that says what to do. Never a status code. */
export function errorSentence(error: ApiError): string {
  if (error.status === 0) return 'The hub isn’t answering. Check that it’s running, then try again.';
  if (error.isSetupRequired) return 'Choose a real password first.';
  if (error.status === 401 && !/password|sign/i.test(error.message)) return 'You’ve been signed out. Reload this page and sign in again.';
  if (error.status === 429) return 'Too many tries. Wait a moment, then try again.';
  const message = error.message.trim();
  // A bare status line ("502 Bad Gateway") is what a proxy says, not the hub.
  if (!message || /^\d{3}\b/.test(message)) return 'That didn’t work. Try again in a moment.';
  return /[.!?…]$/.test(message) ? message : `${message}.`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function formatClock(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatUptime(seconds: number): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 90) return 'a minute';
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return plural(Math.round(seconds / 3600), 'hour');
  return plural(Math.round(seconds / 86400), 'day');
}

/** "1 device", "3 devices". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? singular : plural}`;
}

/**
 * A clock shared by every relative time on screen, so "3 min ago" keeps moving without each
 * component reading the time during render.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function agoText(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown';
  const seconds = Math.round((now - parsed) / 1000);
  if (seconds < 0) return inText(iso, now);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172800) return 'yesterday';
  return new Date(parsed).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function inText(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds <= 0) return 'expired';
  if (seconds < 3600) return `in ${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)} h`;
  const days = Math.round(seconds / 86400);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

export function Ago({ iso }: { iso: string | null | undefined }) {
  const now = useNow();
  return <>{agoText(iso, now)}</>;
}

/* ------------------------------------------------------------------ controls */

export type DotKind = 'ok' | 'warn' | 'bad' | 'busy' | 'off';

/** The status lamp. `label` is what a screen reader hears; the dot itself is decoration. */
export function Sdot({ kind, label, inline }: { kind: DotKind; label?: string; inline?: boolean }) {
  return (
    <>
      <span className={`sdot${kind === 'off' ? '' : ` sdot--${kind}`}${inline ? ' sdot--inline' : ''}`} aria-hidden="true" />
      {label ? <span className="sr">{label}: </span> : null}
    </>
  );
}

export interface PushProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  /** The window's blue default button. */
  primary?: boolean;
  /** While true the button is disabled and reads `busyLabel`. */
  busy?: boolean;
  busyLabel?: string;
  /** Why it is disabled, said on hover and to assistive technology. */
  reason?: string | null;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

export function Push({ primary, busy, busyLabel, reason, disabled, children, className, title, type = 'button', ...rest }: PushProps) {
  const off = Boolean(disabled || busy);
  return (
    <button type={type} className={['push', primary && 'push--default', className].filter(Boolean).join(' ')} disabled={off} aria-busy={busy || undefined} title={off && reason ? reason : title} {...rest}>
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

export function Field({ className, mono, numeric, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; numeric?: boolean; invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input className={['field', mono && 'mono', numeric && 'num', invalid && 'bad-field', className].filter(Boolean).join(' ')} aria-invalid={invalid || undefined} spellCheck={false} autoComplete="off" {...rest} />;
}

export function Pop({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={['pop', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}

export function Check({ checked, onChange, disabled, children, className }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={['chk', className].filter(Boolean).join(' ')}>
      {/* Read the box here, not inside a state updater: React has released the event by then. */}
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="box" />
      <span>{children}</span>
    </label>
  );
}

/** A titled group: the design's fieldset and legend. */
export function Group({ title, tag, hint, children, last, className }: { title: ReactNode; tag?: ReactNode; hint?: ReactNode; children: ReactNode; last?: boolean; className?: string }) {
  return (
    <fieldset className={[last && 'group--last', className].filter(Boolean).join(' ') || undefined}>
      <legend>
        <h2 className="legend-h">{title}</h2>
        {tag}
      </legend>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

/** A bold sub-heading inside a group, as the design writes them. */
export function SubHead({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <p className={`hint subhead${first ? ' subhead--first' : ''}`}>
      <b>{children}</b>
    </p>
  );
}

export function Note({ children, bad, id }: { children: ReactNode; bad?: boolean; id?: string }) {
  return (
    <p className={`note${bad ? ' note--bad' : ''}`} id={id} role={bad ? 'alert' : undefined}>
      {children}
    </p>
  );
}

/** What a failed action says, under the control that failed. */
export function ActionError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return <Note bad>{errorSentence(error)}</Note>;
}

/* ------------------------------------------------------------------ lists and tables */

/**
 * What a list box says before it has rows: loading, failed, or empty. One line of `.empty` text in
 * every case, so nothing jumps when the rows arrive.
 */
export function listState<T>(resource: Resource<T>, isEmpty: (data: T) => boolean, emptyText: string): { text: string; retry?: () => void } | null {
  if (resource.error && !resource.data) return { text: errorSentence(resource.error), retry: resource.reload };
  if (!resource.data) return { text: 'Loading…' };
  if (isEmpty(resource.data)) return { text: emptyText };
  return null;
}

export function EmptyRow({ text, retry }: { text: string; retry?: (() => void) | undefined }) {
  return (
    <li>
      <span className="empty">{text}</span>
      {retry ? <Push onClick={retry}>Try Again</Push> : null}
    </li>
  );
}

export function EmptyCells({ columns, text, retry }: { columns: number; text: string; retry?: (() => void) | undefined }) {
  // A narrow window hides some columns (`.hide-sm`). A cell spanning a hidden column makes the
  // table invent one, so the span is the number of headers actually showing.
  const cell = useRef<HTMLTableCellElement>(null);
  const [span, setSpan] = useState(columns);
  useLayoutEffect(() => {
    const measure = (): void => {
      const heads = cell.current?.closest('table')?.querySelectorAll('thead th');
      if (!heads?.length) return;
      const showing = Array.from(heads).filter((th) => getComputedStyle(th).display !== 'none').length;
      setSpan(showing || columns);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [columns]);
  return (
    <tr>
      <td ref={cell} colSpan={span} className="empty-cell">
        <span className="empty">{text}</span>
        {retry ? <Push onClick={retry}>Try Again</Push> : null}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ status line and confirmation */

export interface ConfirmRequest {
  /** The question, in bold: "Revoke Jalon’s Phone?" */
  title: string;
  /** What will happen, in one or two sentences. */
  text: string;
  /** The verb on the button that goes ahead: "Revoke". */
  verb: string;
}

interface HubUi {
  /** Say something in the status strip for a few seconds, as the design does. */
  say: (text: string) => void;
  /** Ask before a destructive action. Resolves true only when the verb is pressed. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** True while the bootstrap password stands and the server refuses every gated route. */
  gated: boolean;
}

const HubUiContext = createContext<HubUi>({ say: () => undefined, confirm: async () => false, gated: false });

export function useHubUi(): HubUi {
  return useContext(HubUiContext);
}

/**
 * Owns the transient status message and the confirmation sheet. The window renders `message` in its
 * status strip and `sheet` over its pane.
 */
export function HubUiProvider({ gated, children }: { gated: boolean; children: (parts: { message: string | null; sheet: ReactNode; sheetOpen: boolean }) => ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 5000);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const [pending, setPending] = useState<{ request: ConfirmRequest; resolve: (go: boolean) => void } | null>(null);
  const confirm = useCallback((request: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ request, resolve })), []);
  const answer = useCallback(
    (go: boolean) => {
      pending?.resolve(go);
      setPending(null);
    },
    [pending],
  );

  const sheet = pending ? <ConfirmSheet request={pending.request} onAnswer={answer} /> : null;
  const value = useMemo<HubUi>(() => ({ say, confirm, gated }), [say, confirm, gated]);
  return <HubUiContext.Provider value={value}>{children({ message, sheet, sheetOpen: pending !== null })}</HubUiContext.Provider>;
}

/**
 * The confirmation sheet: it drops from under the toolbar, as a Snow Leopard sheet did, and holds
 * the keyboard until it is answered. Cancel has the focus, so Return never destroys anything; Escape
 * cancels; focus goes back to the button that asked.
 */
function ConfirmSheet({ request, onAnswer }: { request: ConfirmRequest; onAnswer: (go: boolean) => void }) {
  const titleId = useId();
  const textId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const asker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (asker?.isConnected) asker.focus();
    };
  }, []);
  return (
    <div className="sheet-layer">
      {/* The dialog owns Escape and the Tab cycle for the two buttons inside it. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onAnswer(false);
          } else if (event.key === 'Tab') {
            // Two buttons: Tab and Shift+Tab both go to the other one.
            event.preventDefault();
            (document.activeElement === cancel.current ? go.current : cancel.current)?.focus();
          }
        }}
      >
        <svg className="gate__icon" viewBox="0 0 26 26" aria-hidden="true">
          <path d="M13 2.5 24 22H2z" fill="#f2c14e" stroke="#9a6a08" strokeLinejoin="round" />
          <path d="M13 9v6.5" stroke="#3b2a05" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="13" cy="18.8" r="1.3" fill="#3b2a05" />
        </svg>
        <div className="sheet__body">
          <b id={titleId}>{request.title}</b>
          <p id={textId}>{request.text}</p>
          <div className="sheet__acts">
            <Push ref={cancel} onClick={() => onAnswer(false)}>
              Cancel
            </Push>
            <Push ref={go} primary onClick={() => onAnswer(true)}>
              {request.verb}
            </Push>
          </div>
        </div>
      </div>
    </div>
  );
}
