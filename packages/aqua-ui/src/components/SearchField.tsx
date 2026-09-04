import { forwardRef, useEffect, useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'size' | 'onSubmit'> {
  value: string;
  onChange: (value: string) => void;
  /** Submit on Enter (when results are not instant). */
  onSubmit?: (value: string) => void;
  onClear?: () => void;
  /** Escape when the field is empty (e.g. close a popover). */
  onEscape?: () => void;
  label?: string;
  size?: 'regular' | 'small';
  /** Combobox wiring for a results popover. */
  combobox?: { expanded: boolean; controls: string; activeDescendant?: string | null };
  /** Scope menu trigger rendered inside the field. */
  scopeTrigger?: ReactNode;
  /** Register Ctrl/Cmd+F (or the given key) to focus the field. */
  shortcut?: boolean | string;
  onArrow?: (direction: 'up' | 'down' | 'pageup' | 'pagedown') => void;
}

/** Rounded recessed search field: magnifier, clear button only when text exists, focus halo (spec §9.15). */
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField({ value, onChange, onSubmit, onClear, onEscape, label = 'Search', size = 'regular', combobox, scopeTrigger, shortcut, onArrow, className, placeholder = 'Search', disabled, onKeyDown, ...rest }, ref) {
  const inner = useRef<HTMLInputElement | null>(null);
  const autoId = useId();
  useEffect(() => {
    if (!shortcut) return;
    const key = typeof shortcut === 'string' ? shortcut.toLowerCase() : 'f';
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === key) {
        e.preventDefault();
        inner.current?.focus();
        inner.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcut]);
  const clear = () => {
    onChange('');
    onClear?.();
    inner.current?.focus();
  };
  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (value) clear();
      else onEscape?.();
    } else if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit(value);
    } else if (onArrow && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp')) {
      e.preventDefault();
      onArrow(e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : e.key === 'PageDown' ? 'pagedown' : 'pageup');
    }
  };
  return (
    <div className={['aqua-search', size === 'small' && 'aqua-search--small', className].filter(Boolean).join(' ')} role="search" data-disabled={disabled ? 'true' : undefined}>
      <span className="aqua-search__lead">
        <span className="aqua-search__icon" aria-hidden="true">
          <Glyph name="search" />
        </span>
        {scopeTrigger}
      </span>
      <input
        ref={(el) => {
          inner.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        id={rest.id ?? `search-${autoId}`}
        type="search"
        className="aqua-search__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        role={combobox ? 'combobox' : undefined}
        aria-expanded={combobox ? combobox.expanded : undefined}
        aria-controls={combobox?.controls}
        aria-autocomplete={combobox ? 'list' : undefined}
        aria-haspopup={combobox ? 'grid' : undefined}
        aria-activedescendant={combobox?.activeDescendant ?? undefined}
        {...rest}
      />
      <span className="aqua-search__clear-hit">
        {value ? (
          <button type="button" className="aqua-search__clear" aria-label="Clear search" title="Clear search" onClick={clear} disabled={disabled}>
            <Glyph name="close" />
          </button>
        ) : null}
      </span>
    </div>
  );
});
