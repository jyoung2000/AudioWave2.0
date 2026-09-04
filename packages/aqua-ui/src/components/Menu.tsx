import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Glyph } from '../icons/glyphs.js';
import { useDismiss, useTypeahead } from '../hooks/index.js';

export type MenuEntry =
  | { kind: 'item'; id: string; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string; checked?: boolean; icon?: React.ReactNode; destructive?: boolean }
  | { kind: 'checkbox'; id: string; label: string; checked: boolean; onToggle: (checked: boolean) => void; disabled?: boolean }
  | { kind: 'submenu'; id: string; label: string; items: MenuEntry[]; disabled?: boolean }
  | { kind: 'separator'; id: string }
  | { kind: 'heading'; id: string; label: string };

export interface MenuProps {
  open: boolean;
  entries: MenuEntry[];
  /** Anchor position (context menu) or element (dropdown). */
  anchor: { x: number; y: number } | HTMLElement | null;
  onClose: () => void;
  label: string;
  /** Element to restore focus to on close. */
  returnFocusTo?: HTMLElement | null;
}

function clampToViewport(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  return { left: Math.max(8, Math.min(x, vw - w - 8)), top: Math.max(8, Math.min(y, vh - h - 8)) };
}

/** Application menu / context menu (spec §9.19): roles, arrows, Home/End, submenus, type-ahead, Escape restores focus. */
export function Menu({ open, entries, anchor, onClose, label, returnFocusTo }: MenuProps) {
  const ref = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [openSub, setOpenSub] = useState<string | null>(null);
  const close = useCallback(() => {
    onClose();
    if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus();
  }, [onClose, returnFocusTo]);
  useDismiss(ref, open, close);
  const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(':scope > li > [role^="menuitem"]:not([aria-disabled="true"])') ?? []);
  useLayoutEffect(() => {
    if (!open || !ref.current || !anchor) return;
    const rect = ref.current.getBoundingClientRect();
    const a = anchor instanceof HTMLElement ? (() => { const r = anchor.getBoundingClientRect(); return { x: r.left, y: r.bottom + 2 }; })() : anchor;
    setPos(clampToViewport(a.x, a.y, rect.width, rect.height));
  }, [open, anchor, entries]);
  useEffect(() => {
    if (!open) return;
    const first = focusables()[0];
    first?.focus();
  }, [open]);
  const labels = entries.map((e) => ('label' in e ? e.label : ''));
  const typeahead = useTypeahead(labels, (idx) => {
    const target = ref.current?.querySelector<HTMLElement>(`[data-index="${idx}"]`);
    target?.focus();
  });
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const list = focusables();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      (list[(i + 1) % list.length] ?? list[0])?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      (list[(i - 1 + list.length) % list.length] ?? list[list.length - 1])?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'ArrowRight') {
      const current = document.activeElement as HTMLElement | null;
      const id = current?.dataset['submenu'];
      if (id) {
        e.preventDefault();
        setOpenSub(id);
      }
    } else if (e.key === 'ArrowLeft') {
      if (openSub) {
        e.preventDefault();
        setOpenSub(null);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    } else {
      const current = document.activeElement as HTMLElement | null;
      const idx = Number(current?.dataset['index'] ?? -1);
      typeahead(e, idx);
    }
  };
  if (!open || typeof document === 'undefined') return null;
  const renderEntries = (items: MenuEntry[], sub = false) => (
    <ul ref={sub ? undefined : ref} className="aqua-menu" role="menu" aria-label={label} style={sub ? { position: 'absolute', left: '100%', top: -5 } : { left: pos.left, top: pos.top }} onKeyDown={sub ? undefined : onKeyDown}>
      {items.map((entry, index) => {
        if (entry.kind === 'separator') return <li key={entry.id} role="separator" className="aqua-menu__separator" />;
        if (entry.kind === 'heading') return <li key={entry.id} role="presentation" className="aqua-menu__heading">{entry.label}</li>;
        if (entry.kind === 'submenu') {
          const isOpen = openSub === entry.id;
          return (
            <li key={entry.id} role="none" style={{ position: 'relative' }} onMouseEnter={() => setOpenSub(entry.id)} onMouseLeave={() => setOpenSub((s) => (s === entry.id ? null : s))}>
              <button type="button" role="menuitem" className="aqua-menu__item" data-index={index} data-submenu={entry.id} data-open={isOpen ? 'true' : undefined} aria-haspopup="menu" aria-expanded={isOpen} aria-disabled={entry.disabled || undefined} onClick={() => setOpenSub(isOpen ? null : entry.id)}>
                <span className="aqua-menu__check" />
                <span className="aqua-menu__label">{entry.label}</span>
                <span />
                <span className="aqua-menu__submenu-arrow" aria-hidden="true"><Glyph name="disclosure-right" /></span>
              </button>
              {isOpen ? renderEntries(entry.items, true) : null}
            </li>
          );
        }
        if (entry.kind === 'checkbox') {
          return (
            <li key={entry.id} role="none">
              <button type="button" role="menuitemcheckbox" className="aqua-menu__item" data-index={index} aria-checked={entry.checked} aria-disabled={entry.disabled || undefined} onClick={() => { if (entry.disabled) return; entry.onToggle(!entry.checked); close(); }}>
                <span className="aqua-menu__check" aria-hidden="true">{entry.checked ? <Glyph name="check" /> : null}</span>
                <span className="aqua-menu__label">{entry.label}</span>
                <span />
                <span />
              </button>
            </li>
          );
        }
        return (
          <li key={entry.id} role="none">
            <button type="button" role="menuitem" className="aqua-menu__item" data-index={index} aria-disabled={entry.disabled || undefined} onClick={() => { if (entry.disabled) return; entry.onSelect(); close(); }} style={entry.destructive ? { color: '#7a1712' } : undefined}>
              <span className="aqua-menu__check" aria-hidden="true">{entry.checked ? <Glyph name="check" /> : entry.icon}</span>
              <span className="aqua-menu__label">{entry.label}</span>
              <span className="aqua-menu__shortcut">{entry.shortcut}</span>
              <span />
            </button>
          </li>
        );
      })}
    </ul>
  );
  return createPortal(<div className="aqua-layer">{renderEntries(entries)}</div>, document.body);
}

/** Convenience hook to manage a context menu's open state/anchor. */
export function useContextMenu() {
  const [state, setState] = useState<{ open: boolean; anchor: { x: number; y: number } | HTMLElement | null; returnFocusTo: HTMLElement | null }>({ open: false, anchor: null, returnFocusTo: null });
  const openAt = useCallback((anchor: { x: number; y: number } | HTMLElement, returnFocusTo: HTMLElement | null = (document.activeElement as HTMLElement | null)) => setState({ open: true, anchor, returnFocusTo }), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { ...state, openAt, close };
}
