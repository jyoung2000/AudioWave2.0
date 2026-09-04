import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';
import { useTypeahead } from '../hooks/index.js';

export interface SourceItem<T extends string = string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number | null;
  disabled?: boolean;
  /** Secondary status text shown in the tooltip (e.g. "needs permission"). */
  status?: string | null;
}

export interface SourceGroup<T extends string = string> {
  id: string;
  label: string;
  items: SourceItem<T>[];
  collapsible?: boolean;
}

export interface SourceListProps<T extends string = string> {
  groups: SourceGroup<T>[];
  selectedId: T | null;
  onSelect: (id: T) => void;
  label?: string;
  /** Selection dims when the list loses focus (spec §9.6). */
  dimUnfocused?: boolean;
  /** Called with a context (secondary action) request for an item. */
  onContextMenu?: (id: T, position: { x: number; y: number }) => void;
  className?: string;
}

/**
 * Persistent cool-blue source list: grouped rows with 16 px icons, roving tabindex, arrow keys,
 * Home/End, type-ahead, Left/Right collapse/expand groups, ≤2 levels (spec §9.6).
 */
export function SourceList<T extends string = string>({ groups, selectedId, onSelect, label = 'Sources', dimUnfocused = true, onContextMenu, className }: SourceListProps<T>) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const visible = useMemo(() => groups.flatMap((g) => (collapsed.has(g.id) ? [] : g.items.map((it) => ({ ...it, groupId: g.id })))), [groups, collapsed]);
  const selectedIndex = Math.max(0, visible.findIndex((v) => v.id === selectedId));
  const [focusIndex, setFocusIndex] = useState(selectedIndex);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const focusItem = useCallback(
    (index: number) => {
      const item = visible[index];
      if (!item) return;
      setFocusIndex(index);
      refs.current.get(item.id)?.focus();
    },
    [visible],
  );
  const typeahead = useTypeahead(
    visible.map((v) => v.label),
    (idx) => focusItem(idx),
  );
  const toggleGroup = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    const item = visible[index];
    if (!item) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(Math.min(visible.length - 1, index + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(Math.max(0, index - 1));
        break;
      case 'Home':
        e.preventDefault();
        focusItem(0);
        break;
      case 'End':
        e.preventDefault();
        focusItem(visible.length - 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!collapsed.has(item.groupId)) toggleGroup(item.groupId);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (collapsed.has(item.groupId)) toggleGroup(item.groupId);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!item.disabled) onSelect(item.id);
        break;
      default:
        typeahead(e, index);
    }
  };
  const currentFocus = Math.min(focusIndex, Math.max(0, visible.length - 1));
  let runningIndex = -1;
  return (
    <nav className={['aqua-source-list', className].filter(Boolean).join(' ')} aria-label={label}>
      <ul className="aqua-source-list__tree">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.id);
          return (
            <li key={g.id} className="aqua-source-list__group" data-expanded={isCollapsed ? 'false' : 'true'}>
              <div
                className="aqua-source-list__heading"
                role={g.collapsible === false ? 'presentation' : 'button'}
                tabIndex={g.collapsible === false ? -1 : 0}
                aria-expanded={g.collapsible === false ? undefined : !isCollapsed}
                aria-controls={`source-group-${g.id}`}
                onClick={() => g.collapsible !== false && toggleGroup(g.id)}
                onKeyDown={(e) => {
                  if (g.collapsible === false) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleGroup(g.id);
                  }
                }}
              >
                <span className="aqua-source-list__heading-label">{g.label}</span>
                {g.collapsible === false ? null : (
                  <span className="aqua-source-list__disclosure" aria-hidden="true">
                    <Glyph name="disclosure-down" />
                  </span>
                )}
              </div>
              <ul id={`source-group-${g.id}`} className="aqua-source-list__rows" role="listbox" aria-label={g.label}>
                {!isCollapsed &&
                  g.items.map((it) => {
                    runningIndex += 1;
                    const index = runningIndex;
                    const selected = it.id === selectedId;
                    return (
                      <li
                        key={it.id}
                        id={`source-${String(it.id)}`}
                        ref={(el) => {
                          if (el) refs.current.set(it.id, el);
                          else refs.current.delete(it.id);
                        }}
                        className="aqua-source-list__row"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={it.disabled || undefined}
                        data-dim-unfocused={dimUnfocused ? 'true' : undefined}
                        tabIndex={index === currentFocus ? 0 : -1}
                        title={it.status ? `${it.label} — ${it.status}` : it.label}
                        onClick={() => {
                          setFocusIndex(index);
                          if (!it.disabled) onSelect(it.id);
                        }}
                        onKeyDown={(e) => onKeyDown(e, index)}
                        onContextMenu={(e) => {
                          if (!onContextMenu) return;
                          e.preventDefault();
                          onContextMenu(it.id, { x: e.clientX, y: e.clientY });
                        }}
                      >
                        <span className="aqua-source-list__icon" aria-hidden="true">
                          {it.icon}
                        </span>
                        <span className="aqua-source-list__label">{it.label}</span>
                        {typeof it.count === 'number' ? (
                          <span className="aqua-source-list__count" aria-label={`${it.count} items`}>
                            {it.count}
                          </span>
                        ) : (
                          <span />
                        )}
                      </li>
                    );
                  })}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
