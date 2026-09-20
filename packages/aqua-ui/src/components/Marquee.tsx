import { useEffect, useRef, type ReactNode } from 'react';
import { useAqua } from '../context.js';
import { runMarquee } from './marquee-engine.js';

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
 *
 * The motion is `marquee-engine.ts`, the same code the list uses for the playing row — this package
 * used to carry two implementations of it, which is two chances to be wrong about the same thing.
 * A `Marquee` rendered on its own keeps its own clock; several labels that must move together
 * belong to one `runMarquee` call instead, which is what `useMarquee` does for a row.
 */
export function Marquee({ children, active, className, title }: MarqueeProps) {
  const { reducedMotion } = useAqua();
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const enabled = active && !reducedMotion;
  useEffect(() => {
    const box = boxRef.current;
    if (!enabled || !box) return;
    return runMarquee([box]);
  }, [enabled, children]);
  return (
    <span ref={boxRef} className={className ? `aqua-marquee ${className}` : 'aqua-marquee'} title={title}>
      <span className="aqua-marquee__inner">{children}</span>
    </span>
  );
}
