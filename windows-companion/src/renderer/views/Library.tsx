/**
 * What the companion found in the music folders: one well, a list in it.
 *
 * The list is a real list — a row is chosen with a click or the arrow keys, several with Shift or
 * Ctrl as Explorer does it, and the two things only this app can do with a file act on what is
 * chosen: Show in Explorer, and Send to Hub. Scan Now reads the folders again; they are also read
 * by themselves whenever something in them changes.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { Track } from '@now-playing/contracts';
import type { HelperStatus } from '../../shared/ipc.js';
import { invoke } from '../bridge.js';
import { formatDuration, plural } from '../format.js';
import { useAction, useChannel, useEvent, type Resource } from '../hooks.js';
import { Push } from '../ui.js';

const PAGE = 300;

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

export function LibraryView({ helper, hubConnected, hasMusicFolder }: { helper: Resource<HelperStatus>; hubConnected: boolean; hasMusicFolder: boolean }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [scanning, setScanning] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const body = useRef<HTMLTableSectionElement | null>(null);

  // The list follows the typing a beat behind, so each letter is not its own search.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 180);
    return () => clearTimeout(timer);
  }, [typed]);

  const tracks = useChannel('library:tracks', { query: query || undefined, limit: PAGE, offset: 0 }, { pollMs: 20_000 });
  const reveal = useAction(async (trackId: string) => invoke('app:reveal', { trackId }));
  const send = useAction(async (trackIds: string[]) => invoke('transfers:send', { trackIds }));
  const scan = useAction(async () => invoke('library:scan', {}));

  useEvent('event:scan-progress', (payload) => {
    setScanning((current) => {
      const next = new Set(current);
      if (payload.done) next.delete(payload.folderId);
      else next.add(payload.folderId);
      return next;
    });
    // What a scan found appears as it finishes, without anyone asking.
    if (payload.done) tracks.reload();
  });

  const items = useMemo(() => tracks.data?.items ?? [], [tracks.data]);
  const total = tracks.data?.total ?? 0;
  const hint = tempoHint(helper.data);
  // A row that has left the list (a search, a rescan) is no longer chosen: only what is on show counts.
  const chosen = items.filter((row) => selected.has(row.id));
  const busy = scanning.size > 0 || scan.busy;


  const show = (row: Track) =>
    void reveal.run(row.id).then((result) => {
      if (result && !result.ok && result.reason) setSaid({ text: result.reason, bad: true });
    });

  const choose = (row: Track, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    setActive(row.id);
    if (event.shiftKey && anchor) {
      const from = items.findIndex((r) => r.id === anchor);
      const to = items.findIndex((r) => r.id === row.id);
      if (from >= 0 && to >= 0) {
        setSelected(new Set(items.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.id)));
        return;
      }
    }
    setAnchor(row.id);
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      return;
    }
    setSelected(new Set([row.id]));
  };

  const focusRow = (id: string) => body.current?.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus();

  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, row: Track, index: number) => {
    const move = (to: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, to))];
      if (!next) return;
      event.preventDefault();
      choose(next, { shiftKey: event.shiftKey, ctrlKey: false, metaKey: false });
      focusRow(next.id);
    };
    if (event.key === 'ArrowDown') return move(index + 1);
    if (event.key === 'ArrowUp') return move(index - 1);
    if (event.key === 'Home') return move(0);
    if (event.key === 'End') return move(items.length - 1);
    if (event.key === 'Enter') {
      event.preventDefault();
      return show(row);
    }
    if (event.key === ' ') {
      event.preventDefault();
      return choose(row, { shiftKey: false, ctrlKey: true, metaKey: false });
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      return setSelected(new Set(items.map((r) => r.id)));
    }
    if (event.key === 'Escape' && selected.size) {
      event.preventDefault();
      setSelected(new Set());
    }
  };

  const sendChosen = () =>
    void send.run(chosen.map((row) => row.id)).then((result) => {
      if (!result) return;
      if (result.reason) setSaid({ text: result.reason, bad: true });
      else setSaid({ text: `Sending ${plural(result.queued, 'song')} to the hub. Progress is under Remote ▸ Transfers.` });
    });

  const scanNow = () =>
    void scan.run().then((result) => {
      if (result?.reason) setSaid({ text: result.reason, bad: !result.started });
      else if (result?.started) setSaid({ text: 'Scanning your music folders.' });
    });

  const sendReason = !hubConnected ? 'Pair an Airwave Hub under Remote to send songs to it.' : !chosen.length ? 'Choose the songs to send first.' : null;
  const tabStop = (active && items.some((row) => row.id === active) ? active : null) ?? items[0]?.id ?? null;
  // An empty library is said once, in the list; "0 songs" under it would only repeat it.
  const counts = tracks.data && (total || query) ? `${plural(total, 'song')}${query ? ' found' : ''}${total > items.length ? ` · showing the first ${items.length.toLocaleString()}` : ''}${chosen.length ? ` · ${chosen.length.toLocaleString()} chosen` : ''}` : '';

  return (
    <fieldset>
      <legend>Music on This PC</legend>
      <p className="hint">What the companion found in your music folders. Choose a song and press Enter to see its file.</p>
      <div className="well tracks" aria-busy={tracks.loading && !tracks.data}>
        <table className="tbl" role="grid" aria-label="Music" aria-multiselectable="true" aria-rowcount={items.length}>
          <thead>
            <tr>
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
            {items.map((row, index) => (
              <tr
                key={row.id}
                data-row={row.id}
                aria-selected={selected.has(row.id)}
                tabIndex={row.id === tabStop ? 0 : -1}
                onClick={(event: MouseEvent<HTMLTableRowElement>) => choose(row, event)}
                onDoubleClick={() => show(row)}
                onKeyDown={(event) => onKey(event, row, index)}
              >
                <td title={row.title}>{row.title}</td>
                <td title={row.artistName}>{row.artistName}</td>
                <td title={row.albumName ?? undefined}>{row.albumName ?? ''}</td>
                <td className="num">{formatDuration(row.durationMs)}</td>
                {/* A tag is plain; a measurement wears ≈ and says so, so nobody mistakes one for the other. */}
                <td className="num">{row.bpm ? row.bpmSource === 'analysis' ? <span title="Measured from the audio">≈{row.bpm}</span> : String(row.bpm) : <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tracks.data && !items.length ? <span className="empty">{query ? `Nothing matches “${query}”.` : hasMusicFolder ? 'No songs found yet — they appear here as the scan reads them.' : 'No music yet — add a music folder above and it is read where it is.'}</span> : null}
        {!tracks.data ? <span className="empty">{tracks.error ?? ' '}</span> : null}
      </div>
      <div className="barrow">
        <input className="field field--search" type="search" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} placeholder="Search titles, artists and albums" aria-label="Search music" spellCheck={false} />
        <Push busy={busy} disabled={!hasMusicFolder} reason={!hasMusicFolder ? 'Add a music folder first.' : null} onClick={scanNow}>
          Scan Now
        </Push>
        <Push disabled={chosen.length !== 1} busy={reveal.busy} reason={chosen.length === 1 ? null : 'Choose one song first.'} onClick={() => chosen[0] && show(chosen[0])}>
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
      {hint && items.some((row) => row.bpm === null) ? <p className="note">{hint}</p> : null}
    </fieldset>
  );
}
