import { useRef, type KeyboardEvent } from 'react';
import { Glyph, type GlyphName } from '../icons/glyphs.js';

export interface ToolTabItem<T extends string> {
  id: T;
  label: string;
  icon: GlyphName;
  /** A count worn as a badge, for the tab that needs attention. */
  badge?: number;
  /** What the badge means, for a screen reader: "3 alerts". */
  badgeLabel?: string;
}

export interface ToolTabsProps<T extends string> {
  tabs: readonly ToolTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /** Prefix for the tab and panel ids, so a page can point a panel at its tab. Default "tool". */
  idPrefix?: string;
  className?: string;
}

/**
 * The window-skin toolbar tabs of the Airwave mockups: a glyph over a label on the chrome sheet,
 * one row, the selected one pressed into the sheet. One tab stop, arrows and Home/End inside the
 * group, and the selection follows the focus (UX-KEY-001). The panel is the caller's: give it
 * `id={`${idPrefix}-pane-${value}`}` and `aria-labelledby={`${idPrefix}-tab-${value}`}`.
 */
export function ToolTabs<T extends string>({ tabs, value, onChange, label, idPrefix = 'tool', className }: ToolTabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targets: Record<string, number | undefined> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    const next = targets[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    refs.current[next]?.focus();
  };
  return (
    <div className={['aqua-tool-tabs', className].filter(Boolean).join(' ')} role="tablist" aria-label={label}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          className="aqua-tool-tab"
          aria-selected={tab.id === value}
          aria-controls={`${idPrefix}-pane-${tab.id}`}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <Glyph name={tab.icon} className="aqua-tool-tab__icon" aria-hidden="true" />
          <span className="aqua-tool-tab__label">{tab.label}</span>
          {tab.badge ? (
            <span className="aqua-tool-tab__badge" aria-label={tab.badgeLabel ?? String(tab.badge)}>
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
