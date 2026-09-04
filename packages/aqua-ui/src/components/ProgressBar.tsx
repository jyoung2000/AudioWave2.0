import type { HTMLAttributes } from 'react';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–100; omit for indeterminate. */
  value?: number | null;
  /** Human status text; required so progress never relies on animation alone (spec §9.17). */
  label: string;
  showValue?: boolean;
  paused?: boolean;
  size?: 'regular' | 'small';
}

export function ProgressBar({ value, label, showValue = true, paused, size = 'regular', className, ...rest }: ProgressBarProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const pct = determinate ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className={['aqua-progress', !determinate && 'aqua-progress--indeterminate', size === 'small' && 'aqua-progress--small', className].filter(Boolean).join(' ')} data-paused={paused ? 'true' : undefined} {...rest}>
      <div className="aqua-progress__row">
        <div
          className="aqua-progress__bar"
          role="progressbar"
          aria-label={label}
          aria-valuemin={determinate ? 0 : undefined}
          aria-valuemax={determinate ? 100 : undefined}
          aria-valuenow={determinate ? Math.round(pct) : undefined}
          aria-valuetext={determinate ? `${Math.round(pct)}%` : label}
          aria-busy={!determinate || undefined}
          style={{ '--aqua-progress': `${pct}%` } as React.CSSProperties}
        >
          <div className="aqua-progress__fill" />
        </div>
        {determinate && showValue ? <span className="aqua-progress__value">{Math.round(pct)}%</span> : null}
      </div>
      <div className="aqua-progress__text" role="status" aria-live="polite">
        {label}
      </div>
    </div>
  );
}
