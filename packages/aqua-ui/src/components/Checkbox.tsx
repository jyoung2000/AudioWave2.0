import { forwardRef, useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  children: ReactNode;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ children, indeterminate, className, ...rest }, ref) {
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <label className={['aqua-check', className].filter(Boolean).join(' ')}>
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        type="checkbox"
        className="aqua-check__input"
        {...rest}
      />
      <span className="aqua-check__box" aria-hidden="true">
        <Glyph name="check" />
        <span className="aqua-check__dash" />
      </span>
      <span className="aqua-check__label">{children}</span>
    </label>
  );
});

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  children: ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ children, className, ...rest }, ref) {
  return (
    <label className={['aqua-check', 'aqua-check--radio', className].filter(Boolean).join(' ')}>
      <input ref={ref} type="radio" className="aqua-check__input" {...rest} />
      <span className="aqua-check__box" aria-hidden="true" />
      <span className="aqua-check__label">{children}</span>
    </label>
  );
});
