import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  disabled?: boolean;
  count?: number;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Scope bar variant sits below the toolbar and narrows the current view (spec §9.9). */
  scope?: boolean;
  scopeLabel?: string;
  className?: string;
  children?: ReactNode;
}

export function Tabs<T extends string>({ tabs, value, onChange, label, scope, scopeLabel, className, children }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const enabled = tabs.map((t, i) => (t.disabled ? -1 : i)).filter((i) => i >= 0);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const pos = enabled.indexOf(index);
    const targets: Record<string, number | undefined> = { ArrowRight: enabled[(pos + 1) % enabled.length], ArrowLeft: enabled[(pos - 1 + enabled.length) % enabled.length], Home: enabled[0], End: enabled[enabled.length - 1] };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  const list = (
    <div className={['aqua-tabs', className].filter(Boolean).join(' ')} role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${baseId}-tab-${t.id}`}
          className="aqua-tab"
          aria-selected={t.id === value}
          aria-controls={children !== undefined ? `${baseId}-panel-${t.id}` : undefined}
          tabIndex={t.id === value ? 0 : -1}
          disabled={t.disabled}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {t.label}
          {typeof t.count === 'number' ? ` (${t.count})` : ''}
        </button>
      ))}
    </div>
  );
  return (
    <>
      {scope ? (
        <div className="aqua-scope">
          {scopeLabel ? <span className="aqua-scope__label">{scopeLabel}</span> : null}
          {list}
        </div>
      ) : (
        list
      )}
      {children !== undefined ? (
        <div role="tabpanel" id={`${baseId}-panel-${value}`} aria-labelledby={`${baseId}-tab-${value}`} className="aqua-tabpanel" tabIndex={0}>
          {children}
        </div>
      ) : null}
    </>
  );
}
