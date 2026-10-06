/**
 * The design's controls, as components.
 *
 * Each of these is the markup `design/frontends/origin/airwave-companion.html` writes by hand — a `.push`
 * button, a `.chk` checkbox with its drawn `.box`, a `.pop` pop-up, the `.rm` round minus, a `.well`
 * of `.rows` — styled by the design's own stylesheet (`@now-playing/aqua-ui/airwave-window.css`).
 * Nothing here has a look of its own; the components exist so a view cannot get the markup subtly
 * wrong, and so the few rules the design leaves to its script (a busy button stays its size, a
 * disabled one says why) live in one place.
 *
 * The drawings they wear are shared with the hub (`@now-playing/aqua-ui/airwave-art`), and so is
 * the stylesheet. The components stay here: the hub's kit writes the same classes but not the same
 * markup or props (its sheet is a `role="alertdialog"` layer, its checkbox reports a boolean, its
 * pop-up takes `<option>` children), so one shared component would change what one of the two
 * renders. design/decisions.md DEC-026 records that, and the styleguide draws both.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ buttons */

export interface PushProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The window's default button: blue while its form is being typed into, as the design draws it. */
  isDefault?: boolean;
  /** Working: disabled, same words, same width — the result arrives beside it, not inside it. */
  busy?: boolean;
  /** Why it is disabled, in a sentence. Shown as the button's tooltip and read with it. */
  reason?: string | null | undefined;
}

export function Push({ isDefault, busy, reason, className, disabled, type, children, ...rest }: PushProps) {
  const off = disabled || busy;
  return (
    <button {...rest} type={type ?? 'button'} className={cx('push', isDefault && 'push--default', className)} disabled={off} aria-busy={busy || undefined} title={off && reason ? reason : rest.title}>
      {children}
    </button>
  );
}

/** The era's round minus: removing is a real command, named for what it removes. */
export function Remove({ label, ...rest }: { label: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>) {
  return (
    <button {...rest} type="button" className="rm" aria-label={label} title={label}>
      –
    </button>
  );
}

/* --------------------------------------------------------------- checkboxes */

export interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children: ReactNode;
  /** A second, quieter line under the label. */
  note?: ReactNode;
}

export function Check({ children, note, className, ...rest }: CheckProps) {
  return (
    <label className={cx('chk', rest.disabled && 'is-off', className)}>
      <input {...rest} type="checkbox" />
      <span className="box" />
      <span>
        {children}
        {note ? (
          <>
            <br />
            <span className="note" style={{ margin: 0 }}>
              {note}
            </span>
          </>
        ) : null}
      </span>
    </label>
  );
}

/** A checkbox row with a bold name and a line of explanation, as the Remote tab draws its options. */
export function Option({ title, children, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'title'> & { title: ReactNode; children: ReactNode }) {
  return (
    <label className={cx('optrow', rest.disabled && 'is-off')}>
      <input {...rest} type="checkbox" />
      <span className="box" />
      <span className="lbl">
        <b>{title}</b>
        <span>{children}</span>
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ pop-ups */

export function Pop({ options, className, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <select {...rest} className={cx('pop', className)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/* -------------------------------------------------------------------- lists */

/** The bezelled well that holds every list. */
export function Rows({ label, children, live, className }: { label: string; children: ReactNode; live?: boolean; className?: string }) {
  return (
    <div className={cx('well', className)}>
      <ul className="rows" aria-label={label} aria-live={live ? 'polite' : undefined}>
        {children}
      </ul>
    </div>
  );
}

/** A quiet line inside a list that has nothing in it: one sentence, what to do next. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <li>
      <span className="empty">{children}</span>
    </li>
  );
}

/** Holds the list's place while the first answer is on its way, so the pane does not jump. */
export function LoadingRow() {
  return (
    <li aria-hidden="true">
      <span className="empty">&nbsp;</span>
    </li>
  );
}

export type DotKind = 'ok' | 'warn' | 'bad' | 'busy' | 'off';

/** The design's status light, with its words: colour never carries the meaning alone. */
export function Status({ kind, children }: { kind: DotKind; children: ReactNode }) {
  return (
    <span className="state">
      <span className={cx('sdot', kind !== 'off' && `sdot--${kind}`)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/** A thin bar: the design's space bar, used for progress as well as for room on a disk. */
export function Progress({ label, value }: { label: string; value: number | null }) {
  const known = value !== null && Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, Math.round(value))) : null;
  return (
    <div className={cx('spacebar', 'progress', !known && 'is-waiting')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(pct !== null ? { 'aria-valuenow': pct } : {})}>
      <i className="this" style={{ left: 0, width: pct !== null ? `${pct}%` : '100%' }} />
    </div>
  );
}

/* ------------------------------------------------------------- confirmation */

export interface ConfirmRequest {
  /** What is about to happen, as a question. */
  title: string;
  /** What it does and does not touch. */
  detail?: string;
  /** The button that does it, named for what it does: “Remove”, “Forget This Hub”. */
  action: string;
  /** A destructive action leaves Cancel as the default, as the Mac did. */
  destructive?: boolean;
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/**
 * Asks before something that cannot be taken back. Outside a provider — a view rendered on its own
 * in a test — it falls back to the browser's own question rather than doing the thing unasked.
 */
export function useConfirm(): Confirm {
  const provided = useContext(ConfirmContext);
  return useMemo<Confirm>(() => provided ?? (async (request) => window.confirm([request.title, request.detail].filter(Boolean).join('\n\n'))), [provided]);
}

/** Where the pane is: below the chrome (title and toolbar) and above the status strip. */
function paneBounds(): { top: number; bottom: number } {
  if (typeof document === 'undefined') return { top: 86, bottom: 0 };
  const chrome = document.querySelector('.win > .chrome')?.getBoundingClientRect();
  const status = document.querySelector('.win > .status')?.getBoundingClientRect();
  const top = chrome && chrome.bottom > 0 ? chrome.bottom : 86;
  const bottom = status && status.height > 0 ? Math.max(0, window.innerHeight - status.top) : 0;
  return { top, bottom };
}

/**
 * The question, as a sheet: it comes down from under the toolbar over the window it belongs to, as
 * Snow Leopard asked, rather than as a second window. It is a modal `<dialog>`, so focus is held
 * inside it, Escape cancels, and focus returns to where it was when it closes.
 *
 * Only the pane under the toolbar dims. The title bar and the toolbar stay as they are — the sheet
 * hangs from them — so the dialog's own backdrop is clear (it still makes the rest of the window
 * inert, which is the modal part) and a layer over the pane alone does the dimming.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [bounds, setBounds] = useState<{ top: number; bottom: number }>({ top: 86, bottom: 0 });
  const resolver = useRef<((answer: boolean) => void) | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const detailId = useId();

  // Measured when the sheet opens and as the window is resized, so the dim fits the pane exactly.
  useEffect(() => {
    if (!request) return undefined;
    const measure = () => setBounds(paneBounds());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [request]);

  const confirm = useCallback<Confirm>((next) => {
    // A second question while one is open answers the first with "no".
    resolver.current?.(false);
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = useCallback((value: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(value);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!request || !element || element.open) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  }, [request]);

  // Unmounting with a question open answers it "no" rather than leaving its asker waiting.
  useEffect(() => () => resolver.current?.(false), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? <div className="sheet-dim" aria-hidden="true" style={{ top: bounds.top, bottom: bounds.bottom }} /> : null}
      {request ? (
        <dialog
          ref={dialog}
          className="sheet"
          style={{ top: bounds.top }}
          aria-labelledby={titleId}
          aria-describedby={request.detail ? detailId : undefined}
          onCancel={(event) => {
            event.preventDefault();
            answer(false);
          }}
        >
          <form
            className="sheet__body"
            method="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              answer(!request.destructive);
            }}
          >
            <h2 id={titleId}>{request.title}</h2>
            {request.detail ? (
              <p className="hint" id={detailId}>
                {request.detail}
              </p>
            ) : null}
            <div className="sheet__acts">
              {request.destructive ? (
                <>
                  <Push onClick={() => answer(true)}>{request.action}</Push>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus -- a sheet's safe answer takes the keyboard, as the platform's own do */}
                  <Push type="submit" isDefault autoFocus>
                    Cancel
                  </Push>
                </>
              ) : (
                <>
                  <Push onClick={() => answer(false)}>Cancel</Push>
                  {/* eslint-disable-next-line jsx-a11y/no-autofocus -- a sheet's default answer takes the keyboard, as the platform's own do */}
                  <Push type="submit" isDefault autoFocus>
                    {request.action}
                  </Push>
                </>
              )}
            </div>
          </form>
        </dialog>
      ) : null}
    </ConfirmContext.Provider>
  );
}
