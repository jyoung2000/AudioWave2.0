import type { ReactNode } from 'react';
import { Glyph } from '../icons/glyphs.js';
import { Spinner } from './Spinner.js';
import { SourceBadge } from './Badge.js';
import { IconButton } from './IconButton.js';
import type { GlyphName } from '../icons/glyphs.js';

export interface ResultAction {
  id: string;
  label: string;
  icon: GlyphName;
  enabled: boolean;
  /** Shown as tooltip when disabled ("Why unavailable?"). */
  why?: string | null;
  onSelect: () => void;
}

export interface ResultRow {
  id: string;
  title: string;
  subtitle: string;
  duration?: string | null;
  artworkUrl?: string | null;
  provider: string;
  providerUrl?: string | null;
  /** Preview handler makes the artwork a button with a countdown ring. */
  onPreview?: () => void;
  previewing?: boolean;
  previewFraction?: number;
  busy?: boolean;
  actions?: ResultAction[];
  /** e.g. "requires sign-in" */
  note?: string | null;
}

export interface ResultsPopoverProps {
  id: string;
  state: 'idle' | 'loading' | 'list' | 'empty' | 'error' | 'partial';
  rows: ResultRow[];
  total: number;
  activeIndex: number;
  onActivate: (index: number) => void;
  onHoverIndex?: (index: number) => void;
  onClear: () => void;
  page?: { index: number; count: number; onPrev: () => void; onNext: () => void };
  message?: ReactNode;
  /** Partial-failure notes, e.g. "SoundCloud did not respond". */
  partialNotes?: string[];
  liveText?: string;
  /** Render statically (gallery/tests) instead of absolutely below the field. */
  static?: boolean;
}

/** Search results (combobox grid popup) in the period "Up Next" popover grammar, restyled to Aqua. Keyboard state is owned by the parent. */
export function ResultsPopover({ id, state, rows, total, activeIndex, onActivate, onHoverIndex, onClear, page, message, partialNotes, liveText, static: isStatic }: ResultsPopoverProps) {
  const countText = state === 'loading' ? 'Searching…' : state === 'list' || state === 'partial' ? `${total} ${total === 1 ? 'result' : 'results'}` : 'Search';
  return (
    <div className={['aqua-results', isStatic && 'aqua-results--static'].filter(Boolean).join(' ')}>
      <div className="aqua-results__head">
        <p className="aqua-results__count">
          {state === 'list' || state === 'partial' ? (
            <>
              <b>Results:</b> {total} {total === 1 ? 'song' : 'songs'}
            </>
          ) : (
            countText
          )}
        </p>
        <button type="button" className="aqua-results__clear" onClick={onClear}>
          Clear
        </button>
      </div>
      {state === 'loading' ? (
        <p className="aqua-results__msg">
          <Spinner /> <span>Searching…</span>
        </p>
      ) : null}
      {state === 'empty' ? <p className="aqua-results__msg">{message ?? 'No matches.'}</p> : null}
      {state === 'error' ? <p className="aqua-results__msg">{message ?? 'Search is unavailable right now.'}</p> : null}
      {(state === 'list' || state === 'partial') && (
        // APG "combobox with grid popup": rows carry the selection, cells hold the option body, the
        // provider badge and the secondary controls, so real buttons stay inside the popup without
        // nesting interactive content in an option. Keyboard state is owned by the combobox input;
        // mousedown is cancelled so pointer use never steals focus from it.
        <div id={id} className="aqua-results__list" role="grid" tabIndex={-1} aria-label="Search results" aria-rowcount={total} onMouseDown={(e) => e.preventDefault()}>
          {rows.map((r, i) => (
            <div key={r.id} id={`${id}-opt-${i}`} role="row" tabIndex={-1} aria-selected={i === activeIndex} aria-rowindex={i + 1} className="aqua-results__row" data-selected={i === activeIndex ? 'true' : undefined} data-busy={r.busy ? 'true' : undefined} onMouseEnter={() => onHoverIndex?.(i)}>
              {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keyboard navigation is owned by the combobox input */}
              <div className="aqua-results__main" role="gridcell" tabIndex={-1} onClick={() => onActivate(i)}>
                <span className="aqua-results__art" aria-hidden="true">
                  {r.artworkUrl ? <img src={r.artworkUrl} alt="" loading="lazy" /> : <Glyph name="note" />}
                </span>
                <span className="aqua-results__meta">
                  <span className="aqua-results__title" title={r.title}>
                    {r.title}
                  </span>
                  <span className="aqua-results__sub" title={r.subtitle}>
                    {r.subtitle}
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                </span>
                {r.duration ? <span className="aqua-results__dur">{r.duration}</span> : null}
              </div>
              <div role="gridcell" className="aqua-results__cell">
                <SourceBadge provider={r.provider} href={r.providerUrl ?? undefined} tabIndex={-1} />
              </div>
              <div role="gridcell" className="aqua-results__actions">
                {r.onPreview ? (
                  <IconButton variant="plain" icon={r.previewing ? 'stop' : 'play'} label={`${r.previewing ? 'Stop preview' : 'Preview'} ${r.title}`} pressed={Boolean(r.previewing)} onClick={r.onPreview} tabIndex={-1} title={r.previewing ? `Stop preview (${Math.round((r.previewFraction ?? 0) * 100)}%)` : 'Preview 15 seconds'} />
                ) : null}
                {r.actions?.map((a) => (
                  <IconButton key={a.id} variant="plain" icon={a.icon} label={a.enabled ? a.label : `${a.label} — ${a.why ?? 'unavailable'}`} title={a.enabled ? a.label : `${a.label}: ${a.why ?? 'unavailable'}`} disabled={!a.enabled} onClick={a.onSelect} tabIndex={-1} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {state === 'partial' && partialNotes?.length ? <p className="aqua-results__msg">{partialNotes.join(' · ')}</p> : null}
      {page && page.count > 1 ? (
        <div className="aqua-results__foot">
          <button type="button" className="aqua-results__page" aria-label="Previous page" onClick={page.onPrev} disabled={page.index === 0} tabIndex={-1}>
            ‹
          </button>
          <span className="aqua-results__dots" aria-hidden="true">
            {Array.from({ length: page.count }, (_, i) => (
              <i key={i} data-on={i === page.index ? 'true' : undefined} />
            ))}
          </span>
          <span className="aqua-results__foot-text">
            Page {page.index + 1} of {page.count}
          </span>
          <button type="button" className="aqua-results__page" aria-label="Next page" onClick={page.onNext} disabled={page.index === page.count - 1} tabIndex={-1}>
            ›
          </button>
        </div>
      ) : null}
      <p className="aqua-visually-hidden" role="status" aria-live="polite">
        {liveText ?? (state === 'list' || state === 'partial' ? `${total} results` : state === 'loading' ? 'Searching' : state === 'empty' ? 'No results' : '')}
      </p>
    </div>
  );
}
