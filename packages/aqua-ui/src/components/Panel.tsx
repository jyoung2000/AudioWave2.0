import type { HTMLAttributes, ReactNode } from 'react';

/** Settings/administration panel with titled sections (Aqua dialog grid). */
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
