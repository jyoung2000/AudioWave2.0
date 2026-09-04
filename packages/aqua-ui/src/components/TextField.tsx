import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Glyph } from '../icons/glyphs.js';
import { InlineValidation, type ValidationKind } from './InlineValidation.js';

interface CommonFieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Validation message; when kind is error the control is marked aria-invalid. */
  validation?: { kind: ValidationKind; message: ReactNode } | null;
  inline?: boolean;
  /** Visually hide the label (still announced). */
  hideLabel?: boolean;
}

export interface TextFieldProps extends CommonFieldProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'children'> {
  multiline?: false;
}

export interface TextAreaFieldProps extends CommonFieldProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'> {
  multiline: true;
}

export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps | TextAreaFieldProps>(function TextField(props, ref) {
  const { label, hint, validation, inline, hideLabel, className, id: givenId, ...rest } = props;
  const autoId = useId();
  const id = givenId ?? `field-${autoId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const validationId = validation ? `${id}-validation` : undefined;
  const invalid = validation?.kind === 'error';
  const describedBy = [hintId, validationId].filter(Boolean).join(' ') || undefined;
  const control =
    'multiline' in rest && rest.multiline ? (
      <textarea ref={ref as React.Ref<HTMLTextAreaElement>} id={id} className="aqua-field__input" aria-invalid={invalid || undefined} aria-describedby={describedBy} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
    ) : (
      <input ref={ref as React.Ref<HTMLInputElement>} id={id} className="aqua-field__input" aria-invalid={invalid || undefined} aria-describedby={describedBy} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
    );
  return (
    <div className={['aqua-field', inline && 'aqua-field--inline', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={['aqua-field__label', hideLabel && 'aqua-visually-hidden'].filter(Boolean).join(' ')}>
        {label}
      </label>
      <div className="aqua-field__control">
        {control}
        {invalid ? (
          <span className="aqua-field__marker" aria-hidden="true">
            <Glyph name="error" />
          </span>
        ) : null}
      </div>
      {hint ? (
        <div id={hintId} className="aqua-field__hint">
          {hint}
        </div>
      ) : null}
      {validation ? <InlineValidation id={validationId} kind={validation.kind}>{validation.message}</InlineValidation> : null}
    </div>
  );
});
