/**
 * What the companion found in the music folders: one well, a list in it.
 *
 * The list is a real list — a row is chosen with a click or the arrow keys, several with Shift or
 * Ctrl as Explorer does it, and the two things only this app can do with a file act on what is
 * chosen: Show in Explorer, and Send to Hub. Scan Now reads the folders again; they are also read
 * by themselves whenever something in them changes.
 *
 * Every song is in it, however many there are. The well scrolls over the whole library, but only
 * the rows in view (and a few either side) are drawn, and they are fetched from the main process a
 * stretch of 200 at a time as they come into view — so 50,000 songs cost what 60 rows cost. The
 * keyboard reaches every row (arrows, Page Up and Down, Home and End), and a choice is kept by song,
 * not by what happens to be drawn: Shift-choosing across stretches never loaded, or Ctrl+A, asks the
 * main process for the ids alone.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type UIEvent } from 'react';
import type { Track } from '@now-playing/contracts';
import type { HelperStatus } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { formatDuration, plural } from '../format.js';
import { useAction, useEvent, type Resource } from '../hooks.js';
import { Push } from '../ui.js';

/** Songs fetched at a time. */
export const PAGE = 200;
/** Each row's height, fixed in styles.css (`.tbl--window`), which is what lets a row's place be computed. */
export const ROW_HEIGHT = 22;
/** Rows drawn beyond the visible ones, so a quick scroll does not show blanks. */
const OVERSCAN = 12;
/** How many rows to draw before the well has been measured (in a test, or the first frame). */
const UNMEASURED_ROWS = 40;
/** The most ids sent to the hub in one request. */
const SEND_CHUNK = 500;

/**
 * Why the Tempo column is still empty, when it is (NP-PRIN-002, UX-SETUP-001): FFmpeg is on its way,
 * FFmpeg could not be set up, or there is none and this PC cannot get one automatically. Null when
 * FFmpeg is here and nothing needs saying.
 */
export function tempoHint(status: HelperStatus | null): string | null {
  const ffmpeg = status?.tools.find((t) => t.id === 'ffmpeg');
  if (!status || ffmpeg?.present) return null;
  // Being set up, or in the queue behind the tool before it: either way it is on its way.
  if (ffmpeg?.setup?.state === 'installing' || (status.running && ffmpeg && !ffmpeg.setup)) return 'Setting up FFmpeg — tempos appear once it finishes.';
  if (ffmpeg?.setup?.state === 'failed') return 'Tempo needs FFmpeg, which could not be set up automatically. Try again in Settings.';
  return 'Tempo needs FFmpeg — install it and scan again.';
}

/** The rows to draw for a scroll position: the visible ones and a margin either side. */
export function windowFor(scrollTop: number, viewport: number, total: number): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: -1 };
  const visible = viewport > 0 ? Math.ceil(viewport / ROW_HEIGHT) : UNMEASURED_ROWS;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total - 1, Math.floor(scrollTop / ROW_HEIGHT) + visible + OVERSCAN);
  return { first, last };
}

interface Loaded {
  /** The search the stretches belong to. A new search starts empty. */
  query: string;
  /**
   * Each stretch, with the reload it was fetched in. A reload (every 20 s, or a scan finishing)
   * fetches the stretches in view again but keeps showing the old ones until each answer is in, so
   * nothing flickers; a stretch out of view is fetched again when it comes back into view.
   */
  pages: Map<number, { generation: number; items: Track[] }>;
  total: number | null;
  error: string | null;
}

const EMPTY = (query: string): Loaded => ({ query, pages: new Map(), total: null, error: null });

export function LibraryView({ helper, hubConnected, hasMusicFolder }: { helper: Resource<HelperStatus>; hubConnected: boolean; hasMusicFolder: boolean }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>(() => EMPTY(''));
  const [scroll, setScroll] = useState({ top: 0, height: 0, header: ROW_HEIGHT });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [scanning, setScanning] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const well = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLTableSectionElement | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const inFlight = useRef(new Set<string>());

  // The list follows the typing a beat behind, so each letter is not its own search.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 180);
    return () => clearTimeout(timer);
  }, [typed]);

  const reveal = useAction(async (trackId: string) => invoke('app:reveal', { trackId }));
  const send = useAction(async (trackIds: string[]) => {
    let queued = 0;
    let reason: string | null = null;
    for (let i = 0; i < trackIds.length; i += SEND_CHUNK) {
      const result = await invoke('transfers:send', { trackIds: trackIds.slice(i, i + SEND_CHUNK) });
      queued += result.queued;
      reason ??= result.reason;
    }
    return { queued, reason: queued ? null : reason };
  });
  const scan = useAction(async () => invoke('library:scan', {}));

  /** Fetches one stretch, once per reload, for the current search; an answer for an older search is dropped. */
  const loadPage = useCallback(
    async (page: number): Promise<void> => {
      const flight = `${query}\u0000${nonce}\u0000${page}`;
      if (inFlight.current.has(flight)) return;
      inFlight.current.add(flight);
      try {
        const result = await invoke('library:tracks', { query: query || undefined, limit: PAGE, offset: page * PAGE });
        setLoaded((current) => {
          const base = current.query === query ? current : EMPTY(query);
          const pages = new Map(base.pages);
          pages.set(page, { generation: nonce, items: result.items });
          return { query, pages, total: result.total, error: null };
        });
      } catch (err) {
        setLoaded((current) => (current.query === query ? { ...current, error: err instanceof Error ? err.message : String(err) } : current));
      } finally {
        inFlight.current.delete(flight);
      }
    },
    [query, nonce],
  );

  // A new search clears what was chosen: a row that has left the list is no longer chosen.
  useEffect(() => {
    setSelected(new Set());
    setActive(null);
    setAnchor(null);
    if (well.current) well.current.scrollTop = 0;
    setScroll((s) => ({ ...s, top: 0 }));
  }, [query]);

  // Every 20 s, and when a scan finishes, the stretches in view are read again.
  useEffect(() => {
    const timer = setInterval(() => setNonce((n) => n + 1), 20_000);
    return () => clearInterval(timer);
  }, []);

  useEvent('event:scan-progress', (payload) => {
    setScanning((current) => {
      const next = new Set(current);
      if (payload.done) next.delete(payload.folderId);
      else next.add(payload.folderId);
      return next;
    });
    // What a scan found appears as it finishes, without anyone asking.
    if (payload.done) setNonce((n) => n + 1);
  });

  const current = loaded.query === query ? loaded : EMPTY(query);
  const total = current.total ?? 0;
  const known = current.total !== null;
  const range = windowFor(scroll.top, scroll.height - scroll.header, known ? total : 0);

  // Fetch each stretch the drawn rows fall in that is missing, or is from before the last reload.
  useEffect(() => {
    const firstPage = Math.floor(range.first / PAGE);
    const lastPage = known ? Math.floor(Math.max(range.last, 0) / PAGE) : 0;
    for (let page = firstPage; page <= lastPage; page += 1) {
      if (current.pages.get(page)?.generation !== nonce) void loadPage(page);
    }
  }, [range.first, range.last, known, nonce, current, loadPage]);

  const trackAt = useCallback((index: number): Track | null => current.pages.get(Math.floor(index / PAGE))?.items[index % PAGE] ?? null, [current]);

  /** The ids from `from` to `to`, in order, when every one of them is loaded; null otherwise. */
  const loadedIds = (from: number, to: number): string[] | null => {
    const out: string[] = [];
    for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
      const track = trackAt(i);
      if (!track) return null;
      out.push(track.id);
    }
    return out;
  };

  /** The same, asked of the main process for a stretch that is not loaded. */
  const fetchIds = async (from: number, to: number): Promise<string[]> => {
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.max(from, to);
    return (await invoke('library:track-ids', { query: query || undefined, offset: lo, limit: Math.min(100_000, hi - lo + 1) })).ids;
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setScroll((s) => (s.top === el.scrollTop && s.height === el.clientHeight ? s : { ...s, top: el.scrollTop, height: el.clientHeight }));
  };

  // The well's height (and the header's) once laid out, and again as the window is resized.
  useLayoutEffect(() => {
    const el = well.current;
    if (!el) return undefined;
    const measure = () => setScroll((s) => ({ ...s, top: el.scrollTop, height: el.clientHeight, header: el.querySelector('thead')?.getBoundingClientRect().height || ROW_HEIGHT }));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Scrolls so a row is in view, below the sticky header. */
  const bringIntoView = (index: number) => {
    const el = well.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (!el.clientHeight) {
      // Not laid out (a hidden pane, the first frame): draw the window around the row all the same.
      setScroll((s) => ({ ...s, top }));
      return;
    }
    const room = el.clientHeight - scroll.header;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + room) el.scrollTop = top + ROW_HEIGHT - room;
    setScroll((s) => ({ ...s, top: el.scrollTop, height: el.clientHeight }));
  };

  // A row the keyboard moved to is focused once it has been drawn.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    const row = body.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  });

  const items = useMemo(() => {
    const rows: Array<{ index: number; track: Track | null }> = [];
    for (let i = range.first; i <= range.last; i += 1) rows.push({ index: i, track: trackAt(i) });
    return rows;
  }, [range.first, range.last, trackAt]);

  const hint = tempoHint(helper.data);
  const chosenCount = selected.size;
  const busy = scanning.size > 0 || scan.busy;

  const show = (trackId: string) =>
    void reveal.run(trackId).then((result) => {
      if (result && !result.ok && result.reason) setSaid({ text: result.reason, bad: true });
    });

  /**
   * Chooses row `index` as a click or a key would: alone, toggled (Ctrl), or as a range from the
   * anchor (Shift). What is loaded is chosen at once; a range reaching into stretches never loaded
   * is asked for, and chosen when the answer comes.
   */
  const choose = (index: number, how: { shift: boolean; toggle: boolean }) => {
    setActive(index);
    const apply = (ids: string[]) => {
      if (how.shift) return setSelected(new Set(ids));
      const id = ids[0];
      if (!id) return;
      if (!how.toggle) return setSelected(new Set([id]));
      setSelected((now) => {
        const next = new Set(now);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    const from = how.shift && anchor !== null ? anchor : index;
    if (!how.shift || anchor === null) setAnchor(index);
    const ids = loadedIds(from, index);
    if (ids) apply(ids);
    else
      void fetchIds(from, index)
        .then(apply)
        .catch(() => setSaid({ text: 'Those songs couldn’t be chosen. Try again in a moment.', bad: true }));
  };

  const move = (to: number, shift: boolean) => {
    if (!total) return;
    const index = Math.max(0, Math.min(total - 1, to));
    pendingFocus.current = index;
    bringIntoView(index);
    choose(index, { shift, toggle: false });
  };

  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number) => {
    const page = Math.max(1, Math.floor((scroll.height - scroll.header) / ROW_HEIGHT) - 1) || 10;
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page, PageUp: index - page, Home: 0, End: total - 1 };
    if (event.key in moves && !(event.ctrlKey && event.key.startsWith('Arrow'))) {
      event.preventDefault();
      return move(moves[event.key]!, event.shiftKey);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const id = trackAt(index)?.id;
      if (id) show(id);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      choose(index, { shift: false, toggle: true });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      return void invoke('library:track-ids', { query: query || undefined, offset: 0, limit: 100_000 }).then((result) => setSelected(new Set(result.ids)));
    }
    if (event.key === 'Escape' && selected.size) {
      event.preventDefault();
      setSelected(new Set());
    }
  };

  const sendChosen = () =>
    void send.run([...selected]).then((result) => {
      if (!result) return;
      if (result.reason) setSaid({ text: result.reason, bad: true });
      else setSaid({ text: `Sending ${plural(result.queued, 'song')} to the hub. Progress is under Remote ▸ Transfers.` });
    });

  const scanNow = () =>
    void scan.run().then((result) => {
      if (result?.reason) setSaid({ text: result.reason, bad: !result.started });
      else if (result?.started) setSaid({ text: 'Scanning your music folders.' });
    });

  const only = chosenCount === 1 ? [...selected][0]! : null;
  const sendReason = !hubConnected ? 'Pair an Airwave Hub under Remote to send songs to it.' : !chosenCount ? 'Choose the songs to send first.' : null;
  const tabStop = active !== null && active >= range.first && active <= range.last ? active : range.first;
  // An empty library is said once, in the list; "0 songs" under it would only repeat it.
  const counts = known && (total || query) ? `${plural(total, 'song')}${query ? ' found' : ''}${chosenCount ? ` · ${chosenCount.toLocaleString()} chosen` : ''}` : '';
  const anyMissingTempo = items.some((row) => row.track && row.track.bpm === null);

  return (
    <fieldset>
      <legend>Music on This PC</legend>
      <p className="hint">What the companion found in your music folders. Choose a song and press Enter to see its file.</p>
      <div className="well tracks" ref={well} onScroll={onScroll} aria-busy={!known}>
        <table className="tbl tbl--window" role="grid" aria-label="Music" aria-multiselectable="true" aria-rowcount={total + 1}>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col">Title</th>
              <th scope="col">Artist</th>
              <th scope="col">Album</th>
              <th scope="col" className="num tbl__time">
                Time
              </th>
              <th scope="col" className="num tbl__tempo">
                Tempo
              </th>
            </tr>
          </thead>
          <tbody ref={body}>
            {range.first > 0 ? (
              <tr className="tbl__spacer" aria-hidden="true" style={{ height: range.first * ROW_HEIGHT }}>
                <td colSpan={5} />
              </tr>
            ) : null}
            {items.map(({ index, track: row }) =>
              row ? (
                <tr
                  // Keyed by place, not by song: a row waiting for its stretch becomes the song in the
                  // same element, so the keyboard's focus stays on it when the answer arrives.
                  key={index}
                  data-index={index}
                  data-row={row.id}
                  aria-rowindex={index + 2}
                  aria-selected={selected.has(row.id)}
                  className={index % 2 ? 'is-even' : undefined}
                  tabIndex={index === tabStop ? 0 : -1}
                  onClick={(event: MouseEvent<HTMLTableRowElement>) => choose(index, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey })}
                  onDoubleClick={() => show(row.id)}
                  onKeyDown={(event) => onKey(event, index)}
                >
                  <td title={row.title}>{row.title}</td>
                  <td title={row.artistName}>{row.artistName}</td>
                  <td title={row.albumName ?? undefined}>{row.albumName ?? ''}</td>
                  <td className="num">{formatDuration(row.durationMs)}</td>
                  {/* A tag is plain; a measurement wears ≈ and says so, so nobody mistakes one for the other. */}
                  <td className="num">{row.bpm ? row.bpmSource === 'analysis' ? <span title="Measured from the audio">≈{row.bpm}</span> : String(row.bpm) : <span className="dim">—</span>}</td>
                </tr>
              ) : (
                <tr key={index} data-index={index} aria-rowindex={index + 2} aria-busy="true" className={index % 2 ? 'is-even' : undefined} tabIndex={index === tabStop ? 0 : -1} onKeyDown={(event) => onKey(event, index)}>
                  <td colSpan={5} className="dim">
                    &nbsp;
                  </td>
                </tr>
              ),
            )}
            {known && range.last < total - 1 ? (
              <tr className="tbl__spacer" aria-hidden="true" style={{ height: (total - 1 - range.last) * ROW_HEIGHT }}>
                <td colSpan={5} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {known && !total ? <span className="empty">{query ? `Nothing matches “${query}”.` : hasMusicFolder ? 'No songs found yet — they appear here as the scan reads them.' : 'No music yet — add a music folder above and it is read where it is.'}</span> : null}
        {!known ? <span className="empty">{current.error ?? ' '}</span> : null}
      </div>
      <div className="barrow">
        <input className="field field--search" type="search" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} placeholder="Search titles, artists and albums" aria-label="Search music" spellCheck={false} />
        <Push busy={busy} disabled={!hasMusicFolder} reason={!hasMusicFolder ? 'Add a music folder first.' : null} onClick={scanNow}>
          Scan Now
        </Push>
        <Push disabled={!only} busy={reveal.busy} reason={only ? null : 'Choose one song first.'} onClick={() => only && show(only)}>
          Show in Explorer
        </Push>
        <Push disabled={Boolean(sendReason)} busy={send.busy} reason={sendReason} onClick={sendChosen}>
          Send to Hub
        </Push>
      </div>
      <p className="note" role="status">
        {said ? <span className={said.bad ? 'note--bad' : undefined}>{said.text} </span> : null}
        {counts}
      </p>
      {/* Unavailable is shown and explained (NP-PRIN-002): silent rows stay silent until the decoder exists. */}
      {hint && anyMissingTempo ? <p className="note">{hint}</p> : null}
    </fieldset>
  );
}
