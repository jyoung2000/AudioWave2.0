import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Show the label text; icon-only segments use the label as accessible name. */
  showLabel?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  segments: readonly Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'regular' | 'small';
  shape?: 'rect' | 'capsule';
  tint?: 'graphite' | 'aqua';
  className?: string;
}

/** Radiogroup semantics: one tab stop, arrows move, Space/Enter select (spec §9.14). */
export function SegmentedControl<T extends string>({ label, segments, value, onChange, size = 'regular', shape = 'rect', tint = 'graphite', className }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = segments.map((s, i) => (s.disabled ? -1 : i)).filter((i) => i >= 0);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const pos = enabled.indexOf(index);
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onChange(segments[index]!.value);
      return;
    }
    const positions: Record<string, number> = { ArrowRight: (pos + 1) % enabled.length, ArrowDown: (pos + 1) % enabled.length, ArrowLeft: (pos - 1 + enabled.length) % enabled.length, ArrowUp: (pos - 1 + enabled.length) % enabled.length, Home: 0, End: enabled.length - 1 };
    const nextPos = positions[e.key];
    if (nextPos === undefined) return;
    e.preventDefault();
    const nextIndex = enabled[nextPos]!;
    onChange(segments[nextIndex]!.value);
    refs.current[nextIndex]?.focus();
  };
  return (
    <div className={['aqua-segmented', size === 'small' && 'aqua-segmented--small', shape === 'capsule' && 'aqua-segmented--capsule', tint === 'aqua' && 'aqua-segmented--aqua', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label}>
      {segments.map((s, i) => {
        const checked = s.value === value;
        return (
          <button
            key={s.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            className="aqua-segmented__item"
            aria-checked={checked}
            aria-label={s.showLabel === false || !s.showLabel ? s.label : undefined}
            title={s.label}
            tabIndex={checked ? 0 : -1}
            disabled={s.disabled}
            onClick={() => onChange(s.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {s.icon}
            {s.showLabel ? <span>{s.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
