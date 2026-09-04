import { useEffect, useRef, type ReactNode } from 'react';
import { useAqua } from '../context.js';

export interface MarqueeProps {
  children: ReactNode;
  /** Only the playing row glides; otherwise a plain ellipsis. */
  active: boolean;
  className?: string;
  title?: string;
}

/**
 * Apple-style label marquee: parks, glides just far enough to reveal the tail, parks, glides back.
 * Disabled under reduced motion (falls back to ellipsis). Travel is measured, never assumed.
 */
export function Marquee({ children, active, className, title }: MarqueeProps) {
  const { reducedMotion } = useAqua();
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const enabled = active && !reducedMotion;
  useEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!enabled || !box || !inner) return;
    const HOLD = 2000, RATE = 38, MIN = 420, MAX = 6000, FADE = 12;
    let raf = 0;
    let dist = 0;
    let dur = MIN;
    const measure = () => {
      dist = Math.max(0, inner.getBoundingClientRect().width - box.getBoundingClientRect().width - 1);
      dur = Math.min(MAX, Math.max(MIN, (dist / RATE) * 1000));
      if (!dist) {
        inner.style.transform = '';
        box.style.setProperty('--mq-fade-l', '0px');
        box.style.setProperty('--mq-fade-r', '0px');
      }
    };
    const ease = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;
    const t0 = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!dist) return;
      const cycle = HOLD * 2 + dur * 2;
      const p = (now - t0) % cycle;
      let x: number;
      if (p < HOLD) x = 0;
      else if (p < HOLD + dur) x = -dist * ease((p - HOLD) / dur);
      else if (p < HOLD * 2 + dur) x = -dist;
      else x = -dist * (1 - ease((p - HOLD * 2 - dur) / dur));
      inner.style.transform = x ? `translate3d(${x.toFixed(2)}px,0,0)` : '';
      box.style.setProperty('--mq-fade-l', `${Math.min(FADE, Math.max(0, -x)).toFixed(2)}px`);
      box.style.setProperty('--mq-fade-r', `${Math.min(FADE, Math.max(0, dist + x)).toFixed(2)}px`);
      raf = requestAnimationFrame(tick);
    };
    measure();
    if (dist) raf = requestAnimationFrame(tick);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { measure(); if (dist && !raf) raf = requestAnimationFrame(tick); }) : null;
    ro?.observe(box);
    const onVis = () => { if (!document.hidden && dist && !raf) raf = requestAnimationFrame(tick); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      inner.style.transform = '';
    };
  }, [enabled, children]);
  if (!enabled) {
    return (
      <span className={['aqua-marquee--static', className].filter(Boolean).join(' ')} title={title}>
        {children}
      </span>
    );
  }
  return (
    <span ref={boxRef} className={['aqua-marquee', className].filter(Boolean).join(' ')} title={title}>
      <span ref={innerRef} className="aqua-marquee__inner">
        {children}
      </span>
    </span>
  );
}
