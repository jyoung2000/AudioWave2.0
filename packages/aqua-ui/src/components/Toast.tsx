import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Glyph, type GlyphName } from '../icons/glyphs.js';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';
export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  action?: { label: string; onSelect: () => void };
}
interface ToastItem extends ToastOptions { id: number; text: string }

const ToastContext = createContext<{ show: (text: string, options?: ToastOptions) => void } | null>(null);
const ICONS: Record<ToastKind, GlyphName> = { info: 'info', success: 'check', warning: 'warning', error: 'error' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const show = useCallback((text: string, options: ToastOptions = {}) => {
    counter.current += 1;
    const id = counter.current;
    setItems((list) => [...list.slice(-2), { id, text, ...options }]);
  }, []);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' ? createPortal(<div className="aqua-toast-region">{items.map((t) => <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />)}</div>, document.body) : null}
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(onDismiss, item.durationMs ?? (item.kind === 'error' ? 6000 : 2600));
    return () => clearTimeout(t);
  }, [paused, item, onDismiss]);
  const kind = item.kind ?? 'info';
  return (
    <div className="aqua-toast" role={kind === 'error' ? 'alert' : 'status'} aria-live={kind === 'error' ? 'assertive' : 'polite'} data-kind={kind} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="aqua-toast__icon" aria-hidden="true"><Glyph name={ICONS[kind]} /></span>
      <span className="aqua-toast__text">{item.text}</span>
      {item.action ? (
        <button type="button" className="aqua-button aqua-button--mini" onClick={() => { item.action!.onSelect(); onDismiss(); }}>
          <span className="aqua-button__label">{item.action.label}</span>
        </button>
      ) : null}
      <button type="button" className="aqua-icon-button" data-variant="plain" aria-label="Dismiss" title="Dismiss" onClick={onDismiss} style={{ minWidth: 22, minHeight: 22 }}>
        <span className="aqua-icon-button__face" style={{ width: 18, height: 16 }}><Glyph name="close" /></span>
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
