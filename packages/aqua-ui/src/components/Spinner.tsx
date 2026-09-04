import type { HTMLAttributes } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  size?: 'small' | 'large';
  /** Accessible status text; when omitted the spinner is decorative and the caller must provide status text. */
  label?: string;
}

/** 12-spoke fan; the animation pauses under reduced motion via --aqua-anim-state. */
export function Spinner({ size = 'small', label, className, ...rest }: SpinnerProps) {
  return (
    <span className={['aqua-spinner', size === 'large' && 'aqua-spinner--large', className].filter(Boolean).join(' ')} role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true} {...rest}>
      {Array.from({ length: 12 }, (_, i) => (
        <i key={i} style={{ transform: `rotate(${i * 30}deg)`, animationDelay: `${(i / 12 - 1).toFixed(3)}s` }} />
      ))}
    </span>
  );
}
