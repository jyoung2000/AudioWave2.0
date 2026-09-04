import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
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

export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  variant?: ButtonVariant;
  size?: 'regular' | 'small' | 'mini';
  wide?: boolean;
  icon?: GlyphName;
  children?: ReactNode;
}

/**
 * A link wearing the button's face.
 *
 * For the things a button genuinely cannot be: a download, or a destination in another tab. A
 * `<button>` with an onClick that assigns `location` looks identical and takes away the middle
 * click, the context menu and the status bar that tell someone where they are about to go — which
 * matters most for exactly these two cases.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink({ variant = 'neutral', size = 'regular', wide, icon, className, children, ...rest }, ref) {
  const classes = ['aqua-button', 'aqua-button--link', size === 'small' && 'aqua-button--small', size === 'mini' && 'aqua-button--mini', wide && 'aqua-button--wide', className].filter(Boolean).join(' ');
  return (
    <a
      ref={ref}
      className={classes}
      data-default={variant === 'default' ? 'true' : undefined}
      data-variant={variant === 'graphite' || variant === 'destructive' ? variant : undefined}
      {...rest}
    >
      {icon ? (
        <span className="aqua-button__icon">
          <Glyph name={icon} />
        </span>
      ) : null}
      <span className="aqua-button__label">{children}</span>
    </a>
  );
});
