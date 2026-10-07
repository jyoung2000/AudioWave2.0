/**
 * The window parts the Search tool needs beyond the design's controls in `ui.tsx`: a titled group,
 * a note, a field, a status lamp, a form sheet, and the tool's own status line. Each writes the
 * markup `airwave-window.css` styles, as the rest of this kit does (DEC-026: the hub's kit writes the
 * same classes with its own components). The form sheet is the companion's `<dialog>` sheet, so
 * focus is held inside it, Escape cancels and focus returns where it was.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react';
import { Push as KitPush } from './ui.js';

/** The design's push button, with the hub kit's `primary` spelling of the default button. */
export function Push({ primary, busy, reason, className, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { primary?: boolean; busy?: boolean; reason?: string | null; className?: string; ref?: Ref<HTMLButtonElement> }) {
  return <KitPush {...rest} isDefault={primary} busy={busy} reason={reason ?? null} className={className} />;
}

export function Field({ className, mono, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; invalid?: boolean }) {
  return <input className={['field', mono && 'mono', invalid && 'bad-field', className].filter(Boolean).join(' ')} aria-invalid={invalid || undefined} spellCheck={false} autoComplete="off" {...rest} />;
}

export function Pop({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={['pop', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}

/** A checkbox that reports on or off, as the hub kit's does. */
export function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={['chk', disabled && 'is-off'].filter(Boolean).join(' ')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span className="box" />
      <span>{children}</span>
    </label>
  );
}

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

export function Note({ children, bad }: { children: ReactNode; bad?: boolean }) {
  return (
    <p className={`note${bad ? ' note--bad' : ''}`} role={bad ? 'alert' : undefined}>
      {children}
    </p>
  );
}

/** What went wrong, as the main process said it. */
export function errorSentence(error: Error): string {
  const message = error.message.trim() || 'That didn’t work. Try again in a moment.';
  return /[.!?…]$/.test(message) ? message : `${message}.`;
}

export function ActionError({ error }: { error: Error | null }) {
  return error ? <Note bad>{errorSentence(error)}</Note> : null;
}

export type DotKind = 'ok' | 'warn' | 'bad' | 'busy' | 'off';

export function Sdot({ kind, inline }: { kind: DotKind; inline?: boolean }) {
  return <span className={`sdot${kind === 'off' ? '' : ` sdot--${kind}`}${inline ? ' sdot--inline' : ''}`} aria-hidden="true" />;
}

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ the tool's sheet and status line */

interface SearchUi {
  /** Say what the tool just did, in its status line, for a few seconds. */
  say: (text: string) => void;
  /** Show a form sheet (a `Sheet`); null puts it away. */
  present: (sheet: ReactNode | null) => void;
}

const SearchUiContext = createContext<SearchUi>({ say: () => undefined, present: () => undefined });

export function useSearchUi(): SearchUi {
  return useContext(SearchUiContext);
}

export function SearchUiProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [sheet, setSheet] = useState<ReactNode | null>(null);
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
  const value = useMemo<SearchUi>(() => ({ say, present: setSheet }), [say]);
  return (
    <SearchUiContext.Provider value={value}>
      {children}
      <p className="note srch__said" role="status" aria-live="polite">
        {message}
      </p>
      {sheet}
    </SearchUiContext.Provider>
  );
}

/**
 * A sheet that asks more than yes or no (Search ▸ Filter…): the companion's modal `<dialog>` sheet,
 * hanging from the toolbar. The first control has the focus; Escape cancels.
 */
export function Sheet({ title, children, onCancel }: { title: string; children: ReactNode; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const asker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    element?.querySelector<HTMLElement>('input, select, button')?.focus();
    return () => {
      if (asker?.isConnected) asker.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="sheet sheet--form"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="sheet__body">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
