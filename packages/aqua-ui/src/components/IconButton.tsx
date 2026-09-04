import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required accessible name; also used as the tooltip. */
  label: string;
  icon?: GlyphName;
  children?: ReactNode;
  variant?: 'framed' | 'plain' | 'capsule';
  size?: 'regular' | 'large';
  pressed?: boolean;
  /** Renders menu affordances: aria-haspopup="menu" and aria-expanded. */
  menu?: boolean;
  expanded?: boolean;
  busy?: boolean;
}

/** Compact visible control inside a ≥32 px hit target (spec §14.2). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, icon, children, variant = 'framed', size = 'regular', pressed, menu, expanded, busy, className, type = 'button', title, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={['aqua-icon-button', size === 'large' && 'aqua-icon-button--large', className].filter(Boolean).join(' ')}
      data-variant={variant === 'framed' ? undefined : variant}
      data-busy={busy ? 'true' : undefined}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-expanded={menu ? Boolean(expanded) : undefined}
      aria-busy={busy || undefined}
      {...rest}
    >
      <span className="aqua-icon-button__face">
        {children ?? (icon ? <Glyph name={icon} /> : null)}
        {menu ? <Glyph name="disclosure-down" className="aqua-icon-button__menu-arrow" /> : null}
      </span>
    </button>
  );
});
