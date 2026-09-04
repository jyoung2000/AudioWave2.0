import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'neutral' | 'default' | 'graphite' | 'destructive';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: 'regular' | 'small' | 'mini';
  wide?: boolean;
  /** Appends a true ellipsis: the action needs more input before completing. */
  ellipsis?: boolean;
  busy?: boolean;
  icon?: GlyphName;
  pressed?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'neutral', size = 'regular', wide, ellipsis, busy, icon, pressed, className, children, type = 'button', disabled, ...rest }, ref) {
  const classes = ['aqua-button', size === 'small' && 'aqua-button--small', size === 'mini' && 'aqua-button--mini', wide && 'aqua-button--wide', className].filter(Boolean).join(' ');
  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      data-default={variant === 'default' ? 'true' : undefined}
      data-variant={variant === 'graphite' || variant === 'destructive' ? variant : undefined}
      data-busy={busy ? 'true' : undefined}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner className="aqua-button__spinner" /> : icon ? <span className="aqua-button__icon"><Glyph name={icon} /></span> : null}
      <span className="aqua-button__label">
        {children}
        {ellipsis ? '…' : null}
      </span>
    </button>
  );
});
