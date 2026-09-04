/**
 * The music list, as the reference draws it.
 *
 * `docs/reference/now-playing-header.html` specifies this list exactly — nine columns, 18 px rows
 * with the Aqua stripe and no rules between them, a glossy embossed sticky header whose sorted
 * column turns blue, monochrome initial badges, an overlay gel scroller that fades when idle, and a
 * marquee that runs only on the playing row. This is that list, not a reinterpretation of it: the
 * markup and the class names are the reference's, the stylesheet block is copied from it verbatim,
 * and the behaviours below are ports of its own code rather than approximations.
 *
 * What is *expanded* is what the columns mean, because the reference's rows are demo data and these
 * are real files:
 *
 * - the platform badge becomes the track's actual source — a file on this device, a hub stream, or
 *   a provider, and it is only a link when a provider gave a canonical URL to link to;
 * - BPM comes from the file's own tags, read at index time, and is a dash when the tag is absent
 *   (the reference fetched it from a third party, which this app will not do);
 * - the download key reports whether the track is genuinely available offline rather than toggling
 *   a decoration: a file in a connected folder already is, and says so.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Playlist, PlaylistItem, Track } from '@now-playing/contracts';
import { RowMenu, useMarquee, useOverlayScroller } from './music-list-behaviours.js';
import { offlineOf, sourceOf } from '../lib/track-source.js';

export type SortKey = 'title' | 'artist' | 'duration' | 'bpm' | 'album';

export interface MusicListProps {
  tracks: readonly Track[];
  /** The track the player is on, tinted and marquee'd. */
  playingTrackId: string | null;
  onPlay: (track: Track, ordered: readonly Track[]) => void;
  onToggleStar: (track: Track) => void;
  playlists: readonly Playlist[];
  playlistItems: readonly PlaylistItem[];
  onTogglePlaylist: (track: Track, playlistId: string) => void;
  onNewPlaylist: (track: Track | null) => void;
  /** Says something briefly — the reference's toast. */
  onSay: (message: string) => void;
  /** Tracks whose file cannot be reopened after a reload; see `offlineOf`. */
  ephemeralTrackIds: ReadonlySet<string>;
  label?: string;
}

function fmt(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function MusicList({ tracks, playingTrackId, onPlay, onToggleStar, playlists, playlistItems, onTogglePlaylist, onNewPlaylist, onSay, ephemeralTrackIds, label = 'Library' }: MusicListProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'title', dir: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);

  const rows = useMemo(() => {
    const key = sort.key;
    const value = (track: Track): string | number => {
      switch (key) {
        case 'artist':
          return track.artistName.toLowerCase();
        case 'album':
          return (track.albumName ?? '').toLowerCase();
        case 'duration':
          return track.durationMs ?? 0;
        case 'bpm':
          return track.bpm ?? 0;
        default:
          return track.title.toLowerCase();
      }
    };
    // The reference's comparator: numbers subtract, strings collate, direction multiplies.
    return [...tracks].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const r = typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y));
      return r * sort.dir;
    });
  }, [tracks, sort]);

  const select = useCallback((id: string, focus: boolean) => {
    setSelectedId(id);
    if (!focus) return;
    // Focus after the render that moves the roving tabindex, not before it.
    requestAnimationFrame(() => tbodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-id="${CSS.escape(id)}"]`)?.focus());
  }, []);

  const toggleSort = (key: SortKey): void => setSort((prev) => (prev.key === key ? { key, dir: (prev.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  useOverlayScroller(scrollRef, barRef, thumbRef, listRef, rows.length);
  useMarquee(tbodyRef, playingTrackId, rows);

  return (
    <>
      <div className="library" ref={listRef}>
        <div className="library__scroll" ref={scrollRef}>
          <table aria-label={label}>
            <colgroup>
              <col style={{ width: '34px' }} />
              <col style={{ width: '38px' }} />
              <col />
              <col className="lib-col-artist" style={{ width: '22%' }} />
              <col style={{ width: '54px' }} />
              <col className="lib-col-bpm" style={{ width: '48px' }} />
              <col style={{ width: '40px' }} />
              <col style={{ width: '40px' }} />
              <col className="lib-col-album" style={{ width: '26%' }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="lib-idx" aria-label="Track number">
                  #
                </th>
                <th scope="col" className="lib-icon" aria-label="Source">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3a15.5 15.5 0 0 0-1.3-5.4A8 8 0 0 1 18.9 11zM12 4.1c.9 1.1 1.7 3.4 2 6.9h-4c.3-3.5 1.1-5.8 2-6.9zM5.1 11a8 8 0 0 1 4.3-5.4A15.5 15.5 0 0 0 8.1 11h-3zm0 2h3c.2 2.1.6 3.9 1.3 5.4A8 8 0 0 1 5.1 13zM12 19.9c-.9-1.1-1.7-3.4-2-6.9h4c-.3 3.5-1.1 5.8-2 6.9zm2.6-.5c.7-1.5 1.1-3.3 1.3-5.4h3a8 8 0 0 1-4.3 5.4z" />
                  </svg>
                </th>
                <SortHeader id="title" sort={sort} onSort={toggleSort}>
                  Song
                </SortHeader>
                <SortHeader id="artist" sort={sort} onSort={toggleSort} className="lib-col-artist">
                  Artist
                </SortHeader>
                <SortHeader id="duration" sort={sort} onSort={toggleSort} className="lib-num">
                  Time
                </SortHeader>
                <SortHeader id="bpm" sort={sort} onSort={toggleSort} className="lib-num lib-col-bpm">
                  BPM
                </SortHeader>
                <th scope="col" className="lib-icon" aria-label="Offline">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M10.8 3h2.4v7.7h4.1L12 17.1 6.7 10.7h4.1z" />
                    <path d="M4.6 19h14.8v2.1H4.6z" />
                  </svg>
                </th>
                <th scope="col" className="lib-icon" aria-label="Star">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z" />
                  </svg>
                </th>
                <SortHeader id="album" sort={sort} onSort={toggleSort} className="lib-col-album">
                  Album
                </SortHeader>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {rows.map((track, index) => {
                const playing = track.id === playingTrackId;
                const selected = track.id === selectedId;
                const source = sourceOf(track);
                const offline = offlineOf(track, ephemeralTrackIds.has(track.id));
                return (
                  <tr
                    key={track.id}
                    data-id={track.id}
                    aria-selected={selected}
                    tabIndex={selected || (!selectedId && index === 0) ? 0 : -1}
                    className={playing ? 'is-playing' : undefined}
                    aria-current={playing ? 'true' : undefined}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('.lib-btn, a')) return;
                      select(track.id, false);
                      onPlay(track, rows);
                    }}
                    onKeyDown={(event) => {
                      // Arrows move the selection, Return commits it — the Finder/iTunes split, so a
                      // long list can be walked without restarting playback on every step.
                      const at = rows.indexOf(track);
                      if (event.key === 'ArrowDown' && at < rows.length - 1) select(rows[at + 1]!.id, true);
                      else if (event.key === 'ArrowUp' && at > 0) select(rows[at - 1]!.id, true);
                      else if (event.key === 'Home') select(rows[0]!.id, true);
                      else if (event.key === 'End') select(rows[rows.length - 1]!.id, true);
                      else if (event.key === 'Enter' || event.key === ' ') onPlay(track, rows);
                      else return;
                      event.preventDefault();
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      select(track.id, false);
                      const rect = event.currentTarget.getBoundingClientRect();
                      // Shift+F10 and the Menu key fire this at (0,0); anchor those to the row.
                      const x = event.clientX || rect.left + 40;
                      const y = event.clientY || rect.bottom - 4;
                      setMenu({ track, x, y });
                    }}
                  >
                    <td className="lib-idx">
                      {playing ? (
                        <svg className="lib-np" viewBox="0 0 12 12" role="img" aria-label="Now playing">
                          <path d="M1 4h2.4L6 1.6v8.8L3.4 8H1z" />
                          <path d="M8 3.6a3 3 0 0 1 0 4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                        </svg>
                      ) : (
                        index + 1
                      )}
                    </td>
                    <td className="lib-icon">
                      {source.href ? (
                        <a className="lib-pf" data-len={source.initials.length} href={source.href} target="_blank" rel="noopener noreferrer" title={source.name} aria-label={`Open ${track.title} on ${source.name} in a new tab`}>
                          {source.initials}
                        </a>
                      ) : (
                        <span className="lib-pf" data-len={source.initials.length} title={source.name} aria-label={source.name}>
                          {source.initials}
                        </span>
                      )}
                    </td>
                    <td className="lib-title">{playing ? <Marquee>{track.title}</Marquee> : track.title}</td>
                    <td className="lib-col-artist">{playing ? <Marquee>{track.artistName}</Marquee> : track.artistName}</td>
                    <td className="lib-num">{fmt(track.durationMs)}</td>
                    <td className="lib-num lib-col-bpm">{track.bpm ? Math.round(track.bpm) : '—'}</td>
                    <td className="lib-icon">
                      <button
                        className="lib-btn lib-dl"
                        type="button"
                        aria-pressed={offline.offline}
                        aria-label={offline.reason}
                        title={offline.reason}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSay(offline.reason);
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          {offline.offline ? <path d="M9.9 15.4 6.4 11.9l1.9-1.9 1.6 1.6 5.8-5.8 1.9 1.9z" /> : <path d="M10.8 3h2.4v7.7h4.1L12 17.1 6.7 10.7h4.1z" />}
                          <path d="M4.6 19h14.8v2.1H4.6z" />
                        </svg>
                      </button>
                    </td>
                    <td className="lib-icon">
                      <button
                        className="lib-btn lib-star"
                        type="button"
                        aria-pressed={track.liked}
                        aria-label={track.liked ? `Remove ${track.title} from favourites` : `Star ${track.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleStar(track);
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z" />
                        </svg>
                      </button>
                    </td>
                    <td className="lib-col-album">{track.albumName ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="library__bar" ref={barRef} aria-hidden="true">
          <div className="library__thumb" ref={thumbRef} />
        </div>
      </div>

      {menu ? (
        <RowMenu
          track={menu.track}
          x={menu.x}
          y={menu.y}
          playlists={playlists}
          playlistItems={playlistItems}
          onTogglePlaylist={onTogglePlaylist}
          onNewPlaylist={onNewPlaylist}
          onClose={() => {
            setMenu(null);
            requestAnimationFrame(() => tbodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-id="${CSS.escape(menu.track.id)}"]`)?.focus());
          }}
        />
      ) : null}
    </>
  );
}

function SortHeader({ id, sort, onSort, className, children }: { id: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (key: SortKey) => void; className?: string; children: ReactNode }) {
  const active = sort.key === id;
  return (
    <th
      scope="col"
      className={className}
      data-sort={id}
      {...(active ? { 'aria-sort': sort.dir > 0 ? ('ascending' as const) : ('descending' as const) } : {})}
      onClick={() => onSort(id)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSort(id);
      }}
      tabIndex={0}
      role="columnheader"
    >
      {children}
      {active ? (
        <span className="lib-sort" aria-hidden="true">
          {sort.dir > 0 ? '▲' : '▼'}
        </span>
      ) : null}
    </th>
  );
}

function Marquee({ children }: { children: ReactNode }) {
  return (
    <span className="lib-mq">
      <span className="lib-mq__in">{children}</span>
    </span>
  );
}
