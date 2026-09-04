import { useId, useState, type KeyboardEvent } from 'react';
import { useDragFraction } from '../hooks/index.js';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  largeStep?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
  /** Show an editable numeric field next to the track. */
  editable?: boolean;
  /** Format the value for aria-valuetext and the readout. */
  format?: (value: number) => string;
  unit?: string;
  className?: string;
  id?: string;
  /**
   * Vertical faders are the Aqua idiom for an equaliser (spec §9.17): the same control, rotated,
   * with drag and arrow keys following the visual direction rather than the horizontal one.
   */
  orientation?: 'horizontal' | 'vertical';
}

/** Generic Aqua slider: narrow recessed track, silver thumb, keyboard steps, editable numeric value (spec §9.17). */
export function Slider({ label, value, min, max, step = 1, largeStep, onChange, onCommit, disabled, editable, format, unit, className, id: givenId, orientation = 'horizontal' }: SliderProps) {
  const autoId = useId();
  const id = givenId ?? `slider-${autoId}`;
  const [editing, setEditing] = useState<string | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
  const fraction = max > min ? (value - min) / (max - min) : 0;
  const drag = useDragFraction(
    (f, phase) => {
      const v = clamp(min + f * (max - min));
      onChange(v);
      if (phase === 'end') onCommit?.(v);
    },
    { disabled, vertical: orientation === 'vertical' },
  );
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = largeStep ?? step * 10;
    const delta = e.shiftKey ? big : step;
    const targets: Record<string, number> = { ArrowRight: value + delta, ArrowUp: value + delta, ArrowLeft: value - delta, ArrowDown: value - delta, PageUp: value + big, PageDown: value - big, Home: min, End: max };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const v = clamp(next);
    onChange(v);
    onCommit?.(v);
  };
  const text = format ? format(value) : `${value}${unit ?? ''}`;
  const commitEdit = () => {
    if (editing === null) return;
    const parsed = Number.parseFloat(editing);
    if (!Number.isNaN(parsed)) {
      const v = clamp(parsed);
      onChange(v);
      onCommit?.(v);
    }
    setEditing(null);
  };
  return (
    <div className={['aqua-slider', orientation === 'vertical' && 'aqua-slider--vertical', className].filter(Boolean).join(' ')} data-orientation={orientation} style={{ '--aqua-fill': `${fraction * 100}%` } as React.CSSProperties}>
      <div
        id={id}
        className="aqua-slider__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        aria-orientation={orientation}
        data-dragging={drag.dragging ? 'true' : undefined}
        onKeyDown={onKeyDown}
        {...drag.handlers}
      >
        <div className="aqua-slider__channel">
          <div className="aqua-slider__fill" />
          <div className="aqua-slider__thumb" />
        </div>
      </div>
      {editable ? (
        <input
          className="aqua-slider__value"
          type="text"
          inputMode="decimal"
          aria-label={`${label} value`}
          value={editing ?? text}
          disabled={disabled}
          onFocus={() => setEditing(String(value))}
          onChange={(e) => setEditing(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setEditing(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      ) : (
        <span className="aqua-slider__readout" aria-hidden="true">
          {text}
        </span>
      )}
    </div>
  );
}
