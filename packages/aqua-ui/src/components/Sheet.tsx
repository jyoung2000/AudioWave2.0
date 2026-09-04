import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../hooks/index.js';
import { Glyph, type GlyphName } from '../icons/glyphs.js';

export interface SheetAction {
  id: string;
  label: string;
  onSelect: () => void;
  variant?: 'neutral' | 'default' | 'destructive' | 'graphite';
  disabled?: boolean;
  busy?: boolean;
  ellipsis?: boolean;
}

export interface SheetProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  icon?: GlyphName;
  children?: ReactNode;
  /** Right-aligned actions; the one with variant "default" is activated by Enter and pulses calmly. */
  actions: SheetAction[];
  /** Left-aligned (separated) dangerous alternatives. */
  leftActions?: SheetAction[];
  onCancel: () => void;
  /** Standalone alert (centred) instead of attached to the top edge. */
  standalone?: boolean;
  wide?: boolean;
  /** Element to focus initially. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Render into this container instead of document.body (attached sheets render inside their window). */
  container?: HTMLElement | null;
}

/**
 * Attached sheet / standalone dialog (spec §9.20): role="dialog", aria-modal, focus trap, Escape cancels,
 * Enter activates the safe default, focus restored on close, 20 px edges, default lower-right, Cancel to its left.
 */
export function Sheet({ open, title, message, icon, children, actions, leftActions, onCancel, standalone, wide, initialFocusRef, container }: SheetProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const messageId = useId();
  useFocusTrap(ref, open, initialFocusRef);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const def = actions.find((a) => a.variant === 'default' && !a.disabled && !a.busy);
        if (def) {
          e.preventDefault();
          def.onSelect();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel, actions]);
  if (!open || typeof document === 'undefined') return null;
  const renderAction = (a: SheetAction) => (
    <button key={a.id} type="button" className="aqua-button" data-default={a.variant === 'default' ? 'true' : undefined} data-variant={a.variant === 'destructive' || a.variant === 'graphite' ? a.variant : undefined} onClick={a.onSelect} disabled={a.disabled || a.busy} aria-busy={a.busy || undefined}>
      <span className="aqua-button__label">
        {a.label}
        {a.ellipsis ? '…' : ''}
      </span>
    </button>
  );
  const node = (
    <div className="aqua-layer">
      <div className="aqua-backdrop" onClick={onCancel} aria-hidden="true" />
      <div ref={ref} className={['aqua-sheet', standalone && 'aqua-sheet--window', wide && 'aqua-sheet--wide', container && 'aqua-sheet--anchored'].filter(Boolean).join(' ')} role={standalone ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} aria-describedby={message ? messageId : undefined} tabIndex={-1}>
        <div className="aqua-sheet__body">
          <div className="aqua-sheet__header">
            {icon ? (
              <span className="aqua-sheet__icon" aria-hidden="true">
                <Glyph name={icon} />
              </span>
            ) : null}
            <div>
              <h2 id={titleId} className="aqua-sheet__title">
                {title}
              </h2>
              {message ? (
                <p id={messageId} className="aqua-sheet__message">
                  {message}
                </p>
              ) : null}
            </div>
          </div>
          {children}
        </div>
        <div className={['aqua-sheet__actions', leftActions?.length && 'aqua-sheet__actions--split'].filter(Boolean).join(' ')}>
          {leftActions?.length ? <div className="aqua-sheet__actions-group">{leftActions.map(renderAction)}</div> : null}
          <div className="aqua-sheet__actions-group">{actions.map(renderAction)}</div>
        </div>
      </div>
    </div>
  );
  return createPortal(node, container ?? document.body);
}

export type DialogProps = Omit<SheetProps, 'standalone'>;
/** Standalone alert for application-wide issues. */
export function Dialog(props: DialogProps) {
  return <Sheet {...props} standalone />;
}
