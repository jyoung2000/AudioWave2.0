/**
 * The window kit's contextual menu (`.menu` in airwave-window.css; UX-SEARCH-012): what a song row's
 * "…" and a right-click open in Search. The companion's kit draws the same markup with its own copy
 * of this component (DEC-026).
 *
 * It opens where it was asked for and stays on screen; the first command that can be used takes the
 * keys. The arrows move (disabled commands are passed over), Home and End jump, Right or Enter opens a
 * submenu (to the left when there is no room on the right) and Left closes it, Enter and Space choose, Escape closes a submenu and then the menu, and
 * Tab or a click outside closes it. Closed by the keys, the focus goes back where it came from.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type MenuEntry =
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean; checked?: boolean; note?: string }
  | { kind: 'sub'; label: string; items: MenuEntry[]; disabled?: boolean; note?: string }
  | { kind: 'sep' };

export interface MenuAt {
  x: number;
  y: number;
}

/** The commands of one level: the buttons that are its own, not its submenu's. */
function commandsOf(level: Element | null): HTMLElement[] {
  if (!level) return [];
  return Array.from(level.children).flatMap((row) => Array.from(row.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('menu__item') && el.getAttribute('aria-disabled') !== 'true'));
}

export function Menu({ label, at, entries, onClose }: { label: string; at: MenuAt; entries: MenuEntry[]; onClose: (refocus: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuAt>(at);
  const [open, setOpen] = useState<number | null>(null);
  const [flip, setFlip] = useState(false);

  // Kept inside the window, then the first command that can be used takes the keys.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const width = window.innerWidth || rect.right;
    const height = window.innerHeight || rect.bottom;
    setPlace({ x: Math.max(8, Math.min(at.x, width - rect.width - 8)), y: Math.max(8, Math.min(at.y, height - rect.height - 8)) });
    commandsOf(node)[0]?.focus();
  }, [at.x, at.y]);

  // A submenu that would run off the right edge hangs to the left of its command instead.
  useLayoutEffect(() => {
    const sub = open === null ? null : box.current?.querySelector('.menu--sub');
    if (!sub) return setFlip(false);
    const rect = sub.getBoundingClientRect();
    const row = sub.parentElement?.getBoundingClientRect() ?? rect;
    setFlip(row.right + rect.width > (window.innerWidth || row.right + rect.width) - 8);
  }, [open]);

  // A press anywhere else closes it, without taking the focus back (the press put it somewhere).
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    const away = (event: PointerEvent): void => {
      if (box.current && event.target instanceof Node && !box.current.contains(event.target)) latestClose.current(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The menu's keys are its own: nothing under it (a list, the page's Escape) hears them.
    event.stopPropagation();
    const here = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const level = here?.closest('.menu') ?? box.current;
    const commands = commandsOf(level);
    const at = here ? commands.indexOf(here) : -1;
    const move = (to: number): void => commands[(to + commands.length) % commands.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(-1);
        break;
      case 'ArrowRight':
        if (here?.getAttribute('aria-haspopup') === 'menu') here.click();
        break;
      case 'ArrowLeft':
      case 'Escape': {
        const parent = level && level !== box.current ? level.parentElement?.querySelector<HTMLElement>(':scope > .menu__item') : null;
        if (parent) {
          setOpen(null);
          parent.focus();
        } else if (event.key === 'Escape') onClose(true);
        break;
      }
      case 'Enter':
      case ' ':
        here?.click();
        break;
      case 'Tab':
        onClose(true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const level = (items: MenuEntry[], depth: number, name: string): ReactNode => (
    <div className={depth ? `menu menu--sub${flip ? ' is-flip' : ''}` : 'menu'} role="menu" aria-label={name} tabIndex={-1} style={depth ? undefined : { left: place.x, top: place.y }} ref={depth ? undefined : box} onKeyDown={depth ? undefined : onKeyDown}>
      {items.map((entry, i) => {
        if (entry.kind === 'sep') return <div key={i} className="menu__sep" role="separator" />;
        const note = entry.note ? <span className="menu__note">{entry.note}</span> : null;
        if (entry.kind === 'sub') {
          const expanded = open === i && depth === 0;
          return (
            <div key={i} className="menu__row" role="none" onPointerEnter={() => !entry.disabled && setOpen(i)}>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-disabled={entry.disabled || undefined}
                onClick={(event) => {
                  if (entry.disabled) return;
                  setOpen(i);
                  const row = event.currentTarget.parentElement;
                  // Opened by the keys, its first command takes them.
                  requestAnimationFrame(() => commandsOf(row?.querySelector('.menu--sub') ?? null)[0]?.focus());
                }}
              >
                {entry.label}
                <span className="menu__arrow" aria-hidden="true">
                  ▶
                </span>
                {note}
              </button>
              {expanded ? level(entry.items, depth + 1, entry.label) : null}
            </div>
          );
        }
        return (
          <div key={i} className="menu__row" role="none" onPointerEnter={() => depth === 0 && setOpen(null)}>
            <button
              type="button"
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={entry.checked}
              className="menu__item"
              tabIndex={-1}
              aria-disabled={entry.disabled || undefined}
              onClick={() => {
                if (entry.disabled) return;
                onClose(true);
                entry.onSelect();
              }}
            >
              {entry.label}
              {note}
            </button>
          </div>
        );
      })}
    </div>
  );

  return createPortal(level(entries, 0, label), document.body);
}
