import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Glyph } from '../icons/glyphs.js';

export type SortDirection = 'ascending' | 'descending';

export interface ColumnDef<Row> {
  id: string;
  header: ReactNode;
  /** Accessible header label when `header` is an icon. */
  headerLabel?: string;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Keep this column visible on narrow widths (primary label). */
  primary?: boolean;
  cell: (row: Row, index: number) => ReactNode;
  /** Text used in the narrow stacked secondary line. */
  stackText?: (row: Row) => string | null;
  className?: string;
}

export interface AquaTableProps<Row> {
  columns: ColumnDef<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  label: string;
  sort?: { columnId: string; direction: SortDirection } | null;
  onSortChange?: (columnId: string, direction: SortDirection) => void;
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>, anchorKey: string | null) => void;
  /** Double-click / Enter. */
  onActivate?: (row: Row) => void;
  onContextMenu?: (row: Row, position: { x: number; y: number }) => void;
  /** Key of the currently playing row (aria-current + speaker glyph in the status column). */
  currentKey?: string | null;
  /** Row height in px (default 20). */
  rowHeight?: number;
  /** Enable virtualization above this row count (default 200). */
  virtualizeAbove?: number;
  /** Height for the scroll container when virtualizing; defaults to filling the parent. */
  height?: number | string;
  emptyMessage?: ReactNode;
  multiSelect?: boolean;
  responsive?: boolean;
  className?: string;
  /** Called when the focused row changes (for LCD/status coordination). */
  onFocusRow?: (row: Row) => void;
  /**
   * Which material the list is made of.
   *
   * `window` is the Aqua list that belongs inside a framed window. `page` is the iTunes 10 list the
   * 2010 page uses: 18 px rows, the Aqua stripe alone separating them (no rules at all), a glossy
   * embossed sticky header whose sorted column turns blue, and a gel overlay scroller that fades
   * when idle. Same behaviour either way — the sorting, the roving tabindex, the shift-range
   * selection and the virtualization are shared, because those are what the list *is*.
   */
  variant?: 'window' | 'page';
}

/**
 * True <table> with sortable header buttons (aria-sort), striped rows, roving tabindex, keyboard
 * navigation and optional virtualization that keeps table semantics via spacer rows (spec §9.8).
 */
export function AquaTable<Row>({ columns, rows, rowKey, label, sort, onSortChange, selectedKeys, onSelectionChange, onActivate, onContextMenu, currentKey, rowHeight = 20, virtualizeAbove = 200, height, emptyMessage = 'No items', multiSelect = true, responsive = true, className, onFocusRow, variant = 'window' }: AquaTableProps<Row>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const page = variant === 'page';
  const scroller = usePageScroller(wrapRef, page);
  const [internalSelection, setInternalSelection] = useState<Set<string>>(new Set());
  const selection = selectedKeys ?? internalSelection;
  const anchor = useRef<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const keys = useMemo(() => rows.map(rowKey), [rows, rowKey]);
  const virtualize = rows.length > virtualizeAbove;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's instance is intentionally not memoized
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => wrapRef.current, estimateSize: () => rowHeight, overscan: 12, enabled: virtualize });
  const setSelection = useCallback(
    (next: Set<string>, a: string | null) => {
      anchor.current = a;
      if (!selectedKeys) setInternalSelection(next);
      onSelectionChange?.(next, a);
    },
    [selectedKeys, onSelectionChange],
  );
  useEffect(() => {
    if (focusIndex > rows.length - 1) setFocusIndex(Math.max(0, rows.length - 1));
  }, [rows.length, focusIndex]);
  const focusRow = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, index));
      setFocusIndex(clamped);
      if (virtualize) virtualizer.scrollToIndex(clamped);
      requestAnimationFrame(() => {
        const el = wrapRef.current?.querySelector<HTMLTableRowElement>(`tr[data-index="${clamped}"]`);
        el?.focus({ preventScroll: !virtualize });
        el?.scrollIntoView({ block: 'nearest' });
      });
      const row = rows[clamped];
      if (row) onFocusRow?.(row);
    },
    [rows, virtualize, virtualizer, onFocusRow],
  );
  const select = (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const key = keys[index]!;
    if (multiSelect && e.shiftKey && anchor.current) {
      const a = keys.indexOf(anchor.current);
      const [lo, hi] = a < index ? [a, index] : [index, a];
      setSelection(new Set(keys.slice(Math.max(0, lo), hi + 1)), anchor.current);
    } else if (multiSelect && (e.ctrlKey || e.metaKey)) {
      const next = new Set(selection);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelection(next, key);
    } else setSelection(new Set([key]), key);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(index + 1);
        if (e.shiftKey && multiSelect) select(Math.min(rows.length - 1, index + 1), e);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(index - 1);
        if (e.shiftKey && multiSelect) select(Math.max(0, index - 1), e);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(rows.length - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        focusRow(index + 20);
        break;
      case 'PageUp':
        e.preventDefault();
        focusRow(index - 20);
        break;
      case ' ':
        e.preventDefault();
        select(index, e);
        break;
      case 'Enter': {
        e.preventDefault();
        const row = rows[index];
        if (row) onActivate?.(row);
        break;
      }
      case 'a':
        if ((e.ctrlKey || e.metaKey) && multiSelect) {
          e.preventDefault();
          setSelection(new Set(keys), anchor.current);
        }
        break;
      default:
        break;
    }
  };
  const toggleSort = (col: ColumnDef<Row>) => {
    if (!col.sortable || !onSortChange) return;
    const dir: SortDirection = sort?.columnId === col.id && sort.direction === 'ascending' ? 'descending' : 'ascending';
    onSortChange(col.id, dir);
  };
  const renderRow = (row: Row, index: number, style?: React.CSSProperties) => {
    const key = keys[index]!;
    const selected = selection.has(key);
    const current = currentKey === key;
    return (
      <tr
        key={key}
        data-index={index}
        aria-selected={selected}
        aria-current={current ? 'true' : undefined}
        className={page && current ? 'is-playing' : undefined}
        tabIndex={index === focusIndex ? 0 : -1}
        style={style}
        onClick={(e) => {
          setFocusIndex(index);
          select(index, e);
          onFocusRow?.(row);
        }}
        onDoubleClick={() => onActivate?.(row)}
        onKeyDown={(e) => onKeyDown(e, index)}
        onContextMenu={(e) => {
          if (!onContextMenu) return;
          e.preventDefault();
          if (!selection.has(key)) setSelection(new Set([key]), key);
          onContextMenu(row, { x: e.clientX, y: e.clientY });
        }}
      >
        {columns.map((col) => (
          <td key={col.id} className={[col.align === 'right' && (page ? 'lib-num' : 'aqua-table--num'), col.align === 'center' && (page ? 'lib-icon' : 'aqua-table--center'), col.primary && (page ? 'lib-title aqua-table__col--keep' : 'aqua-table__col--keep'), col.className].filter(Boolean).join(' ') || undefined}>
            {col.cell(row, index)}
            {responsive && col.primary ? <span className="aqua-table__stack">{columns.filter((c) => c.stackText).map((c) => c.stackText!(row)).filter(Boolean).join(' — ')}</span> : null}
          </td>
        ))}
      </tr>
    );
  };
  const items = virtualize ? virtualizer.getVirtualItems() : null;
  const total = virtualize ? virtualizer.getTotalSize() : 0;
  const before = items && items.length ? items[0]!.start : 0;
  const after = items && items.length ? total - items[items.length - 1]!.end : 0;
  const table = (
      <table className={page ? undefined : ['aqua-table', responsive && 'aqua-table--responsive'].filter(Boolean).join(' ')} aria-label={label} aria-rowcount={rows.length}>
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={c.width !== undefined ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((col) => {
              const sorted = sort?.columnId === col.id ? sort.direction : undefined;
              return (
                <th
                  key={col.id}
                  scope="col"
                  aria-sort={col.sortable ? (sorted ?? 'none') : undefined}
                  data-sortable={page && col.sortable ? 'true' : undefined}
                  className={[col.align === 'right' && (page ? 'lib-num' : 'aqua-table--num'), col.align === 'center' && (page ? 'lib-icon' : 'aqua-table--center'), col.primary && 'aqua-table__col--keep'].filter(Boolean).join(' ') || undefined}
                  aria-label={col.headerLabel}
                >
                  {col.sortable ? (
                    <button type="button" className={page ? undefined : 'aqua-table__sort'} onClick={() => toggleSort(col)} aria-label={col.headerLabel ? `Sort by ${col.headerLabel}` : undefined}>
                      <span className={page ? undefined : 'aqua-table__header-label'}>{col.header}</span>
                      {sorted ? (
                        <span className={page ? 'lib-sort' : 'aqua-table__sort-glyph'} aria-hidden="true">
                          {page ? (sorted === 'ascending' ? '\u25b2' : '\u25bc') : <Glyph name={sorted === 'ascending' ? 'sort-asc' : 'sort-desc'} />}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <span className={page ? undefined : 'aqua-table__sort'} style={page ? undefined : { cursor: 'default' }}>
                      <span className={page ? undefined : 'aqua-table__header-label'}>{col.header}</span>
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="aqua-table__empty">
              <td colSpan={columns.length}>{emptyMessage}</td>
            </tr>
          ) : virtualize && items ? (
            <>
              {before > 0 ? (
                <tr className="aqua-table__spacer" aria-hidden="true">
                  <td colSpan={columns.length} style={{ height: before }} />
                </tr>
              ) : null}
              {items.map((v) => renderRow(rows[v.index]!, v.index, { height: v.size }))}
              {after > 0 ? (
                <tr className="aqua-table__spacer" aria-hidden="true">
                  <td colSpan={columns.length} style={{ height: after }} />
                </tr>
              ) : null}
            </>
          ) : (
            rows.map((row, i) => renderRow(row, i))
          )}
        </tbody>
      </table>
  );
  if (page) {
    return (
      <div className={['library', scroller.active && 'is-scrolling', className].filter(Boolean).join(' ')}>
        <div ref={wrapRef} className="library__scroll" style={height !== undefined ? { maxHeight: height } : undefined}>
          {table}
        </div>
        {scroller.overflowing ? (
          <div className="library__bar" aria-hidden="true">
            <div className="library__thumb" style={{ height: `${scroller.thumbHeight}px`, transform: `translateY(${scroller.thumbTop}px)` }} />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div ref={wrapRef} className={['aqua-table-wrap', className].filter(Boolean).join(' ')} style={height !== undefined ? { height } : undefined}>
      {table}
    </div>
  );
}

/**
 * The gel overlay scroller.
 *
 * Built from elements rather than styling the native bar, because native scrollbar internals cannot
 * animate opacity — and the whole character of this scroller is that it appears while you scroll
 * and dissolves when you stop. It is decorative: the real scrolling is the container's own, so
 * hiding this from assistive technology loses nothing.
 */
function usePageScroller(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [state, setState] = useState({ active: false, overflowing: false, thumbHeight: 0, thumbTop: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let idle = 0;
    const measure = (moving: boolean): void => {
      const track = el.clientHeight - 21;
      const overflowing = el.scrollHeight > el.clientHeight + 1;
      const ratio = overflowing ? el.clientHeight / el.scrollHeight : 1;
      const thumbHeight = Math.max(28, track * ratio);
      const travel = Math.max(0, track - thumbHeight);
      const scrolled = el.scrollHeight - el.clientHeight;
      setState({ active: moving, overflowing, thumbHeight, thumbTop: scrolled > 0 ? (el.scrollTop / scrolled) * travel : 0 });
    };
    const onScroll = (): void => {
      measure(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => measure(false), 700);
    };
    measure(false);
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure(false));
    observer?.observe(el);
    return () => {
      window.clearTimeout(idle);
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [ref, enabled]);
  return state;
}

/** Speaker glyph for the status column of the playing row. */
export function NowPlayingGlyph({ paused }: { paused?: boolean }) {
  return (
    <span className="aqua-table__now-playing" role="img" aria-label={paused ? 'Paused' : 'Now playing'}>
      <Glyph name={paused ? 'pause' : 'speaker'} />
    </span>
  );
}
