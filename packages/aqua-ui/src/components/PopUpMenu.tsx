import { forwardRef, useId, type SelectHTMLAttributes } from 'react';

export interface PopUpOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface PopUpMenuProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'size'> {
  label: string;
  options: readonly PopUpOption[];
  hideLabel?: boolean;
  size?: 'regular' | 'small';
  tint?: 'aqua' | 'graphite';
}

/** Pop-up menu for a manageable set of mutually exclusive values (spec §9.16). Native <select> semantics. */
export const PopUpMenu = forwardRef<HTMLSelectElement, PopUpMenuProps>(function PopUpMenu({ label, options, hideLabel, size = 'regular', tint = 'aqua', className, id: givenId, ...rest }, ref) {
  const autoId = useId();
  const id = givenId ?? `popup-${autoId}`;
  return (
    <div className={['aqua-field', !hideLabel && 'aqua-field--inline', className].filter(Boolean).join(' ')}>
      <label htmlFor={id} className={['aqua-field__label', hideLabel && 'aqua-visually-hidden'].filter(Boolean).join(' ')}>
        {label}
      </label>
      <span className={['aqua-popup', size === 'small' && 'aqua-popup--small'].filter(Boolean).join(' ')} data-tint={tint === 'graphite' ? 'graphite' : undefined}>
        <select ref={ref} id={id} className="aqua-popup__select" {...rest}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="aqua-popup__end" aria-hidden="true">
          <svg viewBox="0 0 8 10" width="8" height="10">
            <path d="M4 0 7 4H1zM4 10 1 6h6z" fill="currentColor" />
          </svg>
        </span>
      </span>
    </div>
  );
});
