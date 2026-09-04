/**
 * The results sheet under the search pill.
 *
 * Modelled on the iTunes 11 "Up Next" popover the reference reproduces: a gradient header with the
 * count and a Clear button, 40 px rows of artwork / title / "Artist — Album", a circled chevron on
 * the row under the pointer.
 *
 * It searches *this device's library only*. Provider results need a hub, and a hub search is a
 * round trip — putting it behind the same field would mean the list under your cursor changes
 * meaning depending on network conditions. The Search section is where provider results live, and
 * the footer here says so and takes you there.
 */
import { useMemo } from 'react';
import type { Track } from '@now-playing/contracts';
import { formatDuration } from '../views/Library.js';

export interface SearchPopoverProps {
  query: string;
  tracks: readonly Track[];
  onPlay: (track: Track) => void;
  onClear: () => void;
  onSeeAll: () => void;
  limit?: number;
}

export function SearchPopover({ query, tracks, onPlay, onClear, onSeeAll, limit = 8 }: SearchPopoverProps) {
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return [];
    return tracks.filter((track) => `${track.title} ${track.artistName} ${track.albumName ?? ''}`.toLowerCase().includes(needle));
  }, [needle, tracks]);
  const shown = matches.slice(0, limit);

  return (
    <>
      <div className="np-results__head">
        <p className="np-results__count">
          {matches.length ? (
            <>
              <b>{matches.length}</b> {matches.length === 1 ? 'result' : 'results'} in your library
            </>
          ) : (
            'Nothing in your library matches'
          )}
        </p>
        <button className="np-results__clear" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="np-results__body">
        {shown.length === 0 ? (
          <p className="np-results__msg">Try a different word, or search providers through a hub in the Search section.</p>
        ) : (
          shown.map((track) => (
            <button key={track.id} type="button" className="np-results__row" onClick={() => onPlay(track)}>
              <span className="np-results__art" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z" />
                </svg>
              </span>
              <span className="np-results__meta">
                <span className="np-results__title">{track.title}</span>
                <span className="np-results__sub">
                  {track.artistName}
                  {track.albumName ? ` — ${track.albumName}` : ''}
                </span>
              </span>
              <span className="np-results__dur">{formatDuration(track.durationMs)}</span>
              <span className="np-results__go" aria-hidden="true">
                ›
              </span>
            </button>
          ))
        )}
      </div>
      {matches.length > shown.length || matches.length === 0 ? (
        <div className="np-results__head" style={{ borderTop: '1px solid var(--np-results-rule)', borderBottom: 0 }}>
          <p className="np-results__count">{matches.length > shown.length ? `${matches.length - shown.length} more` : 'Search providers'}</p>
          <button className="np-results__clear" type="button" onClick={onSeeAll}>
            Open Search
          </button>
        </div>
      ) : null}
    </>
  );
}
