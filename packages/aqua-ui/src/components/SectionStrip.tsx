/**
 * The source list, laid on its side.
 *
 * The old shell put nine sections in a 196 px sidebar, which costs a fifth of a laptop screen and
 * is simply unavailable on a phone. The reference has no sidebar at all, so the sections become a
 * horizontal strip under the status bar.
 *
 * The *semantics do not change*: this is still a `navigation` landmark named "Sections" containing
 * `option`s with the same nine names, with roving tabindex and arrow-key movement. A person using a
 * screen reader or a keyboard learns the same app they learned before; only the pixels moved. That
 * is also why the existing accessibility and end-to-end tests still apply to it unaltered.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTypeahead } from '../hooks/index.js';

export interface SectionItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number | null;
  /** Extra detail for the tooltip and the accessible name (e.g. "needs a hub"). */
  status?: string | null;
}

export interface SectionStripProps<T extends string = string> {
  items: SectionItem<T>[];
  selectedId: T;
  onSelect: (id: T) => void;
  label?: string;
  className?: string;
}

export function SectionStrip<T extends string = string>({ items, selectedId, onSelect, label = 'Sections', className }: SectionStripProps<T>) {
  const refs = useRef(new Map<string, HTMLLIElement>());
  const selectedIndex = Math.max(0, items.findIndex((i) => i.id === selectedId));
  const [focusIndex, setFocusIndex] = useState(selectedIndex);
  const focusItem = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      setFocusIndex(index);
      const el = refs.current.get(item.id);
      el?.focus();
      // A horizontal strip scrolls; keeping the focused row in view is the whole reason it can be
      // narrower than its contents.
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },
    [items],
  );
  const typeahead = useTypeahead(
    items.map((i) => i.label),
    focusItem,
  );
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusItem(Math.min(items.length - 1, index + 1));
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusItem(Math.max(0, index - 1));
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const item = items[index];
        if (item) onSelect(item.id);
        break;
      }
      default:
        typeahead(event, index);
    }
  };
  const currentFocus = Math.min(focusIndex, Math.max(0, items.length - 1));
  return (
    <nav className={['np-sections', className].filter(Boolean).join(' ')} aria-label={label}>
      <div className="np-sections__scroll">
        <ul className="np-sections__list" role="listbox" aria-label={label} aria-orientation="horizontal">
          {items.map((item, index) => (
            <li
              key={item.id}
              ref={(el) => {
                if (el) refs.current.set(item.id, el);
                else refs.current.delete(item.id);
              }}
              className="np-sections__item"
              role="option"
              aria-selected={item.id === selectedId}
              tabIndex={index === currentFocus ? 0 : -1}
              title={item.status ? `${item.label} — ${item.status}` : item.label}
              onClick={() => {
                setFocusIndex(index);
                onSelect(item.id);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.icon ? (
                <span className="np-sections__icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="np-sections__label">{item.label}</span>
              {typeof item.count === 'number' && item.count > 0 ? (
                <span className="np-sections__count" aria-label={`${item.count} items`}>
                  {item.count}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
