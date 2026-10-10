/**
 * A long press on a touch screen opens a row's menu, as a right-click does (CMP-PL-006): a finger
 * (or a pen) held still for 500 ms. Moving more than 10 px first is a scroll or a drag, not a press;
 * lifting early is a tap. The click that follows a press that opened the menu is swallowed, so the
 * row does not also open.
 *
 * A mouse is never timed: it has its right button.
 */
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressHandlers<E extends Element> {
  onPointerDown: (event: ReactPointerEvent<E>) => void;
  onPointerMove: (event: ReactPointerEvent<E>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  /** Put on the same element in the capture phase: drops the click a long press leaves behind. */
  onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
}

export function useLongPress<E extends Element>(onLongPress: (target: Element, point: { x: number; y: number }) => void): LongPressHandlers<E> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const latest = useRef(onLongPress);
  useEffect(() => {
    latest.current = onLongPress;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);

  return {
    onPointerDown: (event) => {
      fired.current = false;
      if (event.pointerType === 'mouse') return;
      cancel();
      const target = event.target as Element;
      const point = { x: event.clientX, y: event.clientY };
      start.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        latest.current(target, point);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      if (!start.current) return;
      if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
