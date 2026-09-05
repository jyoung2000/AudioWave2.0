/**
 * The results sheet under the search pill — the reference's, feature for feature.
 *
 * A gradient header with the count and Clear, 40 px rows whose artwork tile doubles as a
 * fifteen-second audition button with a countdown ring, source badges, time over tempo, a circled
 * chevron on the row under the pointer, a pager in the footer, and a polite live region announcing
 * what happened. The keyboard walks the rows with the arrows and commits with Return, the way the
 * reference's combobox does.
 *
 * Two things are different because the content is, and both are stated where they happen: the rows
 * come from the library on this device (a hub search is a round trip, and the Search section is
 * where that belongs), and the tempo comes from each file's own tags rather than from a third-party
 * lookup this app will not make.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Track } from '@now-playing/contracts';
import { sourceOf } from '@now-playing/aqua-ui';

const PAGE = 5;
const AUDITION_MS = 15_000;
/** Seconds of fade before the cut. A clip that stops mid-note reads as a fault rather than an end. */
const TAIL_S = 0.7;
/** The circumference of the r=13.5 ring the reference draws, so the dash offset is a fraction of it. */
const RING = 84.82;

/**
 * What the search field drives from the keyboard.
 *
 * The rows are a listbox belonging to the combobox above them, so focus stays in the field and the
 * arrows move an `aria-activedescendant` rather than the focus ring. That is why this is a handle
 * rather than a key handler on the list: the keys arrive at the input, not here.
 */
export interface SearchPopoverHandle {
  move: (delta: 1 | -1) => void;
  turn: (delta: 1 | -1) => void;
  commit: () => void;
}

export interface SearchPopoverProps {
  query: string;
  tracks: readonly Track[];
  onPlay: (track: Track) => void;
  onClear: () => void;
  onSeeAll: () => void;
  /** Resolves a blob URL for the audition, or explains why it cannot. */
  onAudition: (track: Track) => Promise<{ url: string; reason: null } | { url: null; reason: string }>;
  /** Called when playback should pause for an audition and resume after it. */
  onAuditionPause?: () => boolean;
  onAuditionResume?: () => void;
  /** Reports the row the arrows are on, so the field can point `aria-activedescendant` at it. */
  onActiveDescendant?: (id: string | null) => void;
  /** Prefix for the row ids, so the field can name them. */
  idPrefix: string;
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const NOTE = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M19.6 3 9.8 5.2a1 1 0 0 0-.8 1v9.7a3.1 3.1 0 1 0 1.6 2.7V9.6l7.6-1.7v5.6a3.1 3.1 0 1 0 1.6 2.7V3.8a.8.8 0 0 0-1-.8z" />
  </svg>
);

export const SearchPopover = forwardRef<SearchPopoverHandle, SearchPopoverProps>(function SearchPopover(
  { query, tracks, onPlay, onClear, onSeeAll, onAudition, onAuditionPause, onAuditionResume, onActiveDescendant, idPrefix },
  ref,
) {
  const [rawPage, setPage] = useState(0);
  const [rawHot, setHot] = useState(-1);
  const [audition, setAudition] = useState<{ id: string; progress: number } | null>(null);
  const [says, setSays] = useState('');
  const player = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const frame = useRef(0);
  const resumeAfter = useRef(false);

  const needle = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!needle) return [];
    return tracks.filter((track) => `${track.title} ${track.artistName} ${track.albumName ?? ''}`.toLowerCase().includes(needle));
  }, [needle, tracks]);

  /*
   * The page and the hot row are *clamped* rather than reset from an effect. Typing narrows the
   * results under them, and an effect that corrects afterwards renders one frame of a page that
   * does not exist. Deriving means there is never such a frame.
   */
  const pages = Math.max(1, Math.ceil(results.length / PAGE));
  const page = Math.min(rawPage, pages - 1);
  const visible = results.slice(page * PAGE, page * PAGE + PAGE);
  const hot = rawHot >= visible.length ? -1 : rawHot;

  const stopAudition = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    const element = player.current;
    player.current = null;
    if (element) {
      element.pause();
      // Dropping the src as well as pausing: a paused element holding a revoked blob URL keeps the
      // decoder and the buffer alive for as long as the element is reachable.
      element.removeAttribute('src');
      try {
        element.load();
      } catch {
        /* a browser that refuses to reload an empty element has already stopped, which is the point */
      }
    }
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setAudition(null);
    if (resumeAfter.current) {
      resumeAfter.current = false;
      onAuditionResume?.();
    }
  }, [onAuditionResume]);

  // A popover that closes, or a query that changes, must not leave audio playing behind it.
  useEffect(() => stopAudition, [stopAudition]);

  useEffect(() => {
    onActiveDescendant?.(hot >= 0 && visible[hot] ? `${idPrefix}-opt-${visible[hot]!.id}` : null);
  }, [hot, visible, idPrefix, onActiveDescendant]);

  const startAudition = useCallback(
    async (track: Track) => {
      if (audition?.id === track.id) {
        stopAudition();
        return;
      }
      stopAudition();
      const resolved = await onAudition(track);
      if (resolved.url === null) {
        setSays(resolved.reason);
        return;
      }
      resumeAfter.current = onAuditionPause?.() ?? false;
      url.current = resolved.url;
      const element = new Audio(resolved.url);
      player.current = element;
      setAudition({ id: track.id, progress: 0 });
      setSays(`Auditioning ${track.title}`);
      void element.play().catch(() => {
        setSays('This browser would not start the audition.');
        stopAudition();
      });
      element.addEventListener('ended', stopAudition);
      element.addEventListener('error', stopAudition);
      /*
       * The ring follows the audio's own clock, not a wall clock: a file that stalls for a second
       * should have its ring stall with it rather than run ahead of what is being heard. The last
       * 0.7 s ramps the level down so the clip ends instead of being cut off.
       */
      const tick = (): void => {
        frame.current = 0;
        if (player.current !== element) return;
        const clip = AUDITION_MS / 1000;
        const left = clip - element.currentTime;
        element.volume = left < TAIL_S ? Math.max(0, left / TAIL_S) : 1;
        if (element.currentTime >= clip) {
          stopAudition();
          return;
        }
        setAudition({ id: track.id, progress: Math.min(1, element.currentTime / clip) });
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    },
    [audition, onAudition, onAuditionPause, stopAudition],
  );

  /*
   * The arrows walk off the end of a page into the next one rather than wrapping back to the top of
   * the same five rows. Wrapping inside a page hides the fact that there are more results below;
   * paging is what the pager in the footer does, and the keyboard should reach the same places.
   */
  const move = useCallback(
    (delta: 1 | -1): void => {
      if (!visible.length) return;
      const at = hot < 0 ? (delta === 1 ? -1 : visible.length) : hot;
      const next = at + delta;
      if (next >= 0 && next < visible.length) {
        setHot(next);
        return;
      }
      if (delta === 1 && page < pages - 1) {
        setPage(page + 1);
        setHot(0);
      } else if (delta === -1 && page > 0) {
        setPage(page - 1);
        setHot(PAGE - 1);
      }
    },
    [visible.length, hot, page, pages],
  );

  const turn = useCallback(
    (delta: 1 | -1): void => {
      const next = Math.min(pages - 1, Math.max(0, page + delta));
      if (next === page) return;
      setPage(next);
      setHot(-1);
    },
    [page, pages],
  );

  useImperativeHandle(
    ref,
    () => ({
      move,
      turn,
      commit: () => {
        const track = visible[hot];
        if (track) onPlay(track);
      },
    }),
    [move, turn, visible, hot, onPlay],
  );

  return (
    <>
      <div className="srch__head">
        <p className="srch__count">
          {results.length ? (
            <>
              <b>{results.length}</b> {results.length === 1 ? 'result' : 'results'} in your library
            </>
          ) : (
            'Nothing in your library matches'
          )}
        </p>
        <button className="srch__clear" type="button" onClick={onClear}>
          Clear
        </button>
      </div>

      <div className="srch__body" role="listbox" id={`${idPrefix}-list`} aria-label="Search results">
        {visible.length === 0 ? (
          <p className="srch__msg">Try a different word, or search the services your hub knows about from the Search section.</p>
        ) : (
          visible.map((track, index) => {
            const badge = sourceOf(track);
            const auditioning = audition?.id === track.id;
            return (
              /* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- the field above owns
                 the keys and points aria-activedescendant here; the row itself is pointer-only */
              <div
                key={track.id}
                id={`${idPrefix}-opt-${track.id}`}
                className={['srch__row', index === hot && 'is-hot'].filter(Boolean).join(' ')}
                role="option"
                tabIndex={-1}
                aria-selected={index === hot}
                onMouseEnter={() => setHot(index)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('.srch__art, .srch__pf')) return;
                  onPlay(track);
                }}
              >
                <button
                  className={['srch__art', auditioning && 'is-preview'].filter(Boolean).join(' ')}
                  type="button"
                  aria-pressed={auditioning}
                  aria-label={auditioning ? `Stop auditioning ${track.title}` : `Audition ${track.title}, 15 seconds`}
                  style={auditioning ? ({ ['--p' as string]: String(audition.progress) } as React.CSSProperties) : undefined}
                  onClick={() => void startAudition(track)}
                >
                  {NOTE}
                  <span className="srch__scrim">
                    <svg viewBox="0 0 30 30" aria-hidden="true" focusable="false">
                      <circle className="srch__ring" cx="15" cy="15" r="13.5" />
                      <circle className="srch__ring srch__ring--on" cx="15" cy="15" r="13.5" style={{ strokeDasharray: RING }} />
                      <path className="srch__glyph srch__play" d="M12 10.5 19 15l-7 4.5z" />
                      <rect className="srch__glyph srch__stop" x="11.5" y="11.5" width="7" height="7" rx="1" />
                    </svg>
                  </span>
                </button>

                <span className="srch__meta">
                  <span className="srch__title">{track.title}</span>
                  <span className="srch__sub">
                    {track.artistName}
                    {track.albumName ? ` — ${track.albumName}` : ''}
                  </span>
                </span>

                <span className="srch__nums">
                  <span className="srch__time">{fmtTime(track.durationMs)}</span>
                  <span className="srch__bpm">{track.bpm ? `${Math.round(track.bpm)} bpm` : '—'}</span>
                </span>

                <span className="srch__links">
                  {badge.href ? (
                    <a className="srch__pf" data-len={badge.initials.length} href={badge.href} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-label={`Open ${track.title} on ${badge.name}`}>
                      {badge.initials}
                    </a>
                  ) : (
                    <span className="srch__pf" data-len={badge.initials.length} title={badge.name}>
                      {badge.initials}
                    </span>
                  )}
                </span>

                <span className="srch__go" aria-hidden="true">
                  ›
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="srch__foot" hidden={results.length <= PAGE && results.length > 0}>
        {results.length > PAGE ? (
          <>
            <button className="srch__page" type="button" tabIndex={-1} aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              ‹
            </button>
            <span className="srch__dots" aria-hidden="true">
              {Array.from({ length: pages }, (_, i) => (
                <i key={i} className={i === page ? 'is-on' : undefined} />
              ))}
            </span>
            <button className="srch__page" type="button" tabIndex={-1} aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
              ›
            </button>
          </>
        ) : (
          <button className="srch__page" type="button" style={{ width: 'auto', padding: '0 8px' }} onClick={onSeeAll}>
            Open Search
          </button>
        )}
      </div>

      <p className="srch__live" role="status">
        {says}
      </p>
    </>
  );
});
