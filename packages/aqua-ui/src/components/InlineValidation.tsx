import type { HTMLAttributes, ReactNode } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';

export type ValidationKind = 'error' | 'warning' | 'success' | 'info';
const ICONS: Record<ValidationKind, GlyphName> = { error: 'error', warning: 'warning', success: 'check', info: 'info' };

export interface InlineValidationProps extends HTMLAttributes<HTMLParagraphElement> {
  kind: ValidationKind;
  children: ReactNode;
}

/** Message + icon; never colour alone (spec §14.1). */
export function InlineValidation({ kind, children, className, ...rest }: InlineValidationProps) {
  return (
    <p className={['aqua-validation', className].filter(Boolean).join(' ')} data-kind={kind} role={kind === 'error' ? 'alert' : undefined} {...rest}>
      <span className="aqua-validation__icon" aria-hidden="true">
        <Glyph name={ICONS[kind]} />
      </span>
      <span>{children}</span>
    </p>
  );
}
