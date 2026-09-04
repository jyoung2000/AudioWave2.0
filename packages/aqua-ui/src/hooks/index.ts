import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

/** Roving tabindex helper for lists of items (source list, table rows, tiles, menus). */
export function useRovingTabIndex(count: number, initialIndex = 0) {
  const [focusIndex, setFocusIndex] = useState(Math.min(initialIndex, Math.max(0, count - 1)));
  useEffect(() => {
    if (focusIndex > count - 1) setFocusIndex(Math.max(0, count - 1));
  }, [count, focusIndex]);
  const move = useCallback(
    (delta: number, wrap = false) => {
      setFocusIndex((i) => {
        if (count === 0) return 0;
        const next = i + delta;
        if (wrap) return (next + count) % count;
        return Math.max(0, Math.min(count - 1, next));
      });
    },
    [count],
  );
  const tabIndexFor = (index: number) => (index === focusIndex ? 0 : -1);
  return { focusIndex, setFocusIndex, move, tabIndexFor };
}

/** Focus trap for modal layers with focus restoration on unmount (spec §9.20). */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
        (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
      );
    const target = initialFocus?.current ?? focusables()[0] ?? container;
    target.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const current = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (current === first || !container.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [active, containerRef, initialFocus]);
}

/** Type-ahead: collects characters typed within 600 ms and returns the matching index. */
export function useTypeahead(labels: readonly string[], onMatch: (index: number) => void) {
  const buffer = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(
    (e: KeyboardEvent, fromIndex: number) => {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === ' ' && buffer.current === '') return false;
      buffer.current += e.key.toLowerCase();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        buffer.current = '';
      }, 600);
      const q = buffer.current;
      const n = labels.length;
      for (let step = 1; step <= n; step += 1) {
        const idx = (fromIndex + step) % n;
        if (labels[idx]!.toLowerCase().startsWith(q)) {
          onMatch(idx);
          return true;
        }
      }
      return false;
    },
    [labels, onMatch],
  );
}

/** Controlled/uncontrolled state helper. */
export function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (v: T) => void): [T, (v: T) => void] {
  const [inner, setInner] = useState(defaultValue);
  const isControlled = value !== undefined;
  const current = isControlled ? value : inner;
  const set = useCallback(
    (v: T) => {
      if (!isControlled) setInner(v);
      onChange?.(v);
    },
    [isControlled, onChange],
  );
  return [current, set];
}

/** Close on outside pointer-down or Escape for popovers/menus. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void, options: { ignore?: RefObject<HTMLElement | null>[] } = {}) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (options.ignore?.some((r) => r.current?.contains(t))) return;
      onDismiss();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onDismiss, ref, options.ignore]);
}

/** Pointer drag helper for sliders/scrubbers/splitters returning a fraction 0..1 along the element. */
export function useDragFraction(onChange: (fraction: number, phase: 'start' | 'move' | 'end') => void, options: { disabled?: boolean; vertical?: boolean } = {}) {
  const [dragging, setDragging] = useState(false);
  const compute = (el: HTMLElement, e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    const raw = options.vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, raw));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (options.disabled || e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    onChange(compute(el, e), 'start');
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging || options.disabled) return;
    onChange(compute(e.currentTarget, e), 'move');
  };
  const end = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging) return;
    setDragging(false);
    onChange(compute(e.currentTarget, e), 'end');
  };
  return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end } };
}

let idCounter = 0;
/** Stable unique id fallback when React's useId is unavailable in a host. */
export function nextId(prefix = 'aqua'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}
