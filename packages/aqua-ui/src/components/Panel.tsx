import type { HTMLAttributes, ReactNode } from 'react';

/** Settings/administration panel with titled sections and aligned form rows (Aqua dialog grid). */
export function Panel({ title, children, className, ...rest }: { title?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={['aqua-panel', className].filter(Boolean).join(' ')} {...rest}>
      {title ? <h2 className="aqua-panel__title">{title}</h2> : null}
      {children}
    </div>
  );
}

export function PanelSection({ title, children, className, ...rest }: { title?: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={['aqua-panel__section', className].filter(Boolean).join(' ')} aria-label={title} {...rest}>
      {title ? <h3 className="aqua-panel__section-title">{title}</h3> : null}
      {children}
    </section>
  );
}

export function FormRow({ label, children, stacked, htmlFor }: { label: ReactNode; children: ReactNode; stacked?: boolean; htmlFor?: string }) {
  return (
    <div className={['aqua-form-row', stacked && 'aqua-form-row--stacked'].filter(Boolean).join(' ')}>
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <div>{label}</div>}
      <div>{children}</div>
    </div>
  );
}

export function KeyValueList({ items }: { items: Array<{ key: string; value: ReactNode }> }) {
  return (
    <dl className="aqua-kv">
      {items.map((it) => (
        <div key={it.key} style={{ display: 'contents' }}>
          <dt>{it.key}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ListView({ rows }: { rows: Array<{ id: string; primary: ReactNode; secondary?: ReactNode; trailing?: ReactNode }> }) {
  return (
    <div className="aqua-list-view" role="list">
      {rows.map((r) => (
        <div key={r.id} className="aqua-list-view__row" role="listitem">
          <div>
            <div className="aqua-list-view__primary">{r.primary}</div>
            {r.secondary ? <div className="aqua-list-view__secondary">{r.secondary}</div> : null}
          </div>
          <div>{r.trailing}</div>
        </div>
      ))}
    </div>
  );
}
