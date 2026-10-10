/**
 * Music ▸ Playlists (DEC-041; UX-PL-001…UX-PL-008): the hub's own playlists, kept as files in its
 * playlist folder, and the folder itself.
 *
 * - **The list** (UX-PL-006): a row per playlist with its 2×2 mosaic, its name and "12 songs · 48 min";
 *   one tab stop, the arrows move, Enter or a click opens it like an album (UX-SEARCH-004). A list
 *   dropped into the folder by hand says it was made outside Airwave.
 * - **A playlist** (UX-PL-007): its head (mosaic, name, length) with Rename…, Export .m3u8 and Delete…
 *   (asked first), then its songs. A song moves by drag, or by Alt+↑/↓ on the highlighted row; Delete
 *   takes it out; its "…" (or a right-click, Shift+F10) has the same commands and its link.
 * - **The folder** (UX-PL-001): where the files are, inside the data volume, and Change… — a path
 *   under `playlists/` or `library/` the server checks — with an offer to move the playlists there.
 * - **Shared from players**: the copies paired players sync to the hub, as they always were — read
 *   here, shared from Sharing, never written by the hub.
 */
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { FolderPlaylistEntry, FolderPlaylistPage, FolderPlaylistSummary, PlaylistFolderInfo, ShareSources } from '@now-playing/contracts';
import { formatDuration } from '@now-playing/domain/catalog';
import { api, type ApiError } from '../lib/api.js';
import { useResource } from '../lib/hooks.js';
import { Menu, type MenuAt, type MenuEntry } from '../lib/menu.js';
import { hubPlaylists, lengthText, playlistSummaryLine, whereText } from '../lib/playlists.js';
import { ActionError, Check, count, errorSentence, Field, Group, listState, Note, Push, Sheet, useHubUi } from '../ui.js';

/** Songs a playlist page asks for at a time. */
const ENTRY_PAGE = 200;

function asApiError(err: unknown): ApiError {
  return err as ApiError;
}

/** A playlist's cover: its own mosaic of its first four songs' artwork, or the empty tile. */
export function Mosaic({ covers, big }: { covers: readonly string[]; big?: boolean }) {
  const cls = ['art', covers.length >= 2 && 'art--mosaic', big && 'art--big'].filter(Boolean).join(' ');
  if (covers.length < 2) return <span className={cls}>{covers[0] ? <img src={covers[0]} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}</span>;
  const four = [0, 1, 2, 3].map((i) => covers[i % covers.length]!);
  return (
    <span className={cls}>
      {four.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
      ))}
    </span>
  );
}

export function PlaylistsView() {
  const list = useResource('playlistsList', {}, { pollMs: 30_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const { present, say } = useHubUi();
  const data = list.data;

  const newPlaylist = (): void => {
    present(
      <NameSheet
        title="New Playlist"
        verb="Create"
        initial=""
        onCancel={() => present(null)}
        onSave={async (name) => {
          const made = await hubPlaylists.create(name);
          present(null);
          list.reload();
          say(`Made “${made.name}”. Songs join it from Search: a song’s … ▸ Add to Playlist.`);
        }}
      />,
    );
  };

  if (openId) {
    return (
      <PlaylistPage
        id={openId}
        onBack={() => {
          setOpenId(null);
          list.reload();
        }}
      />
    );
  }

  const state = listState(list, (d) => d.items.length === 0, 'No playlists yet. Make one here, or from Search: a song’s … ▸ Add to Playlist ▸ New Playlist….');
  return (
    <>
      <Group title="Playlists" hint={data ? <>Kept as .m3u8 files in <code>{data.folder.path}</code>, one per playlist, that any player can open. Lists put in that folder by hand show up here too.</> : 'Kept as .m3u8 files in the hub’s playlist folder, one per playlist.'}>
        {state ? (
          <div className="well">
            <ul className="rows" aria-label="Playlists">
              <li>
                <span className="empty">{state.text}</span>
                {state.retry ? <Push onClick={state.retry}>Try Again</Push> : null}
              </li>
            </ul>
          </div>
        ) : (
          <PlaylistIndex items={data!.items} onOpen={(p) => setOpenId(p.id)} />
        )}
        {data && !data.folder.available ? <Note bad>{data.folder.reason}</Note> : null}
        {data?.folder.capped ? <Note>The folder holds more playlists than the hub reads (1,000). The rest are left alone.</Note> : null}
        <div className="barrow">
          <Push onClick={newPlaylist}>New Playlist…</Push>
        </div>
      </Group>
      <FolderGroup folder={data?.folder ?? null} onChanged={list.reload} />
      <SharedFromPlayers />
    </>
  );
}

/* ------------------------------------------------------------------ the list of playlists */

function PlaylistIndex({ items, onOpen }: { items: readonly FolderPlaylistSummary[]; onOpen: (p: FolderPlaylistSummary) => void }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const at = Math.min(active, items.length - 1);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) setActive(Math.max(0, Math.min(items.length - 1, at + step)));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(items.length - 1);
    else if (event.key === 'Enter') onOpen(items[at]!);
    else return;
    event.preventDefault();
  };
  return (
    <div className="well">
      <ul className="rows mrows" role="listbox" aria-label="Playlists" tabIndex={0} aria-activedescendant={`${id}-${at}`} onKeyDown={onKeyDown}>
        {items.map((p, i) => (
          // The list box owns the keys (UX-KEY-001); a click on a row opens it, as Enter does.
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events
          <li key={p.id} id={`${id}-${i}`} role="option" aria-selected={i === at} onClick={() => onOpen(p)}>
            <Mosaic covers={p.covers} />
            <span className="mrow__main">
              <span className="mrow__title">{p.name}</span>
              <span className="mrow__sub">{playlistSummaryLine(p)}</span>
            </span>
            <span className="mrow__meta">{p.readOnly ? <span className="mrow__bpm">Hand-made</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ one playlist */

function PlaylistPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { present, say, confirm } = useHubUi();
  const [page, setPage] = useState<FolderPlaylistPage | null>(null);
  const [entries, setEntries] = useState<FolderPlaylistEntry[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const first = await hubPlaylists.page(id, 0, ENTRY_PAGE);
      setPage(first);
      setEntries(first.items);
      setError(null);
    } catch (err) {
      setError(asApiError(err));
    }
  }, [id]);
  useEffect(() => {
    void load().then(() => heading.current?.focus());
  }, [load]);

  const more = async (): Promise<void> => {
    if (!page) return;
    setBusy(true);
    try {
      const next = await hubPlaylists.page(id, entries.length, ENTRY_PAGE);
      setEntries((e) => [...e, ...next.items]);
      setPage({ ...next, items: [] });
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = page?.playlist ?? null;
  const total = page?.total ?? 0;

  const act = async (work: () => Promise<FolderPlaylistSummary>, said: string): Promise<void> => {
    try {
      await work();
      await load();
      say(said);
    } catch (err) {
      say(errorSentence(asApiError(err)));
    }
  };
  const move = (entry: FolderPlaylistEntry, to: number): void => {
    if (to < 0 || to >= total) return;
    void act(() => hubPlaylists.move(id, entry.id, to), `Moved “${entry.title}” to number ${to + 1}.`);
  };
  const removeEntry = (entry: FolderPlaylistEntry): void => void act(() => hubPlaylists.removeEntries(id, [entry.id]), `Took “${entry.title}” out of “${summary?.name ?? 'the playlist'}”.`);

  const rename = (): void => {
    if (!summary) return;
    present(
      <NameSheet
        title={`Rename “${summary.name}”`}
        verb="Rename"
        initial={summary.name}
        onCancel={() => present(null)}
        onSave={async (name) => {
          const renamed = await hubPlaylists.rename(id, name);
          present(null);
          await load();
          say(`Renamed to “${renamed.name}”; its file is ${renamed.fileName}.`);
        }}
      />,
    );
  };
  const remove = async (): Promise<void> => {
    if (!summary) return;
    const yes = await confirm({ title: `Delete “${summary.name}”?`, text: `Its .m3u8 file and its sidecar are deleted from the playlist folder. The ${count(summary.entryCount, 'song')} stay in the library and at their sources.`, verb: 'Delete' });
    if (!yes) return;
    try {
      await hubPlaylists.remove(id);
      say(`Deleted “${summary.name}”.`);
      onBack();
    } catch (err) {
      say(errorSentence(asApiError(err)));
    }
  };

  return (
    <section className="srch__page" aria-labelledby="pl-page-h">
      <div className="barrow barrow--above srch__nav">
        <Push onClick={onBack} aria-label="Back to Playlists">
          ‹ Back
        </Push>
        <h2 id="pl-page-h" className="srch__h" tabIndex={-1} ref={heading}>
          {summary?.name ?? 'Playlist'}
        </h2>
      </div>
      {error && !summary ? <ActionError error={error} /> : null}
      {summary ? (
        <>
          <div className="mhead">
            <Mosaic covers={summary.covers} big />
            <div className="mhead__text">
              <b className="mhead__title">{summary.name}</b>
              <span className="mhead__line">Playlist · {playlistSummaryLine(summary)}</span>
              {summary.description ? <span className="mhead__line">{summary.description}</span> : null}
              <span className="mhead__line">{summary.fileName}</span>
              <div className="barrow">
                <Push onClick={rename}>Rename…</Push>
                <a className="push push--link" href={hubPlaylists.exportUrl(id)} download={summary.fileName.replace(/\.m3u$/i, '.m3u8')}>
                  Export .m3u8
                </a>
                <Push onClick={() => void remove()}>Delete…</Push>
              </div>
            </div>
          </div>
          {summary.readOnly ? <Note>Made outside Airwave. It stays as it is until it is changed here; then the hub keeps a sidecar beside it.</Note> : null}
          <EntryList entries={entries} total={total} onMove={move} onRemove={removeEntry} />
          {entries.length < total ? (
            <div className="barrow">
              <Push busy={busy} onClick={() => void more()}>
                More Songs ({(total - entries.length).toLocaleString('en')} left)
              </Push>
            </div>
          ) : null}
          {summary.durationSec ? <p className="note">{count(total, 'song')}, {lengthText(summary.durationSec)} in all.</p> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * A playlist's songs (UX-PL-007): one tab stop; the arrows, Home and End move; Alt+↑/↓ moves the
 * highlighted song; Delete takes it out; Shift+F10, the Menu key, a right-click or its "…" open its
 * menu; a song can be dragged to another place.
 */
function EntryList({ entries, total, onMove, onRemove }: { entries: readonly FolderPlaylistEntry[]; total: number; onMove: (entry: FolderPlaylistEntry, to: number) => void; onRemove: (entry: FolderPlaylistEntry) => void }) {
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ index: number; at: MenuAt } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const at = Math.min(active, Math.max(0, entries.length - 1));

  if (!entries.length) {
    return (
      <div className="well">
        <ul className="rows" aria-label="Songs">
          <li>
            <span className="empty">No songs yet. Songs join from Search: a song’s … ▸ Add to Playlist.</span>
          </li>
        </ul>
      </div>
    );
  }

  const openMenu = (index: number, point?: MenuAt): void => {
    const row = list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${index}`)}`);
    const rect = row?.getBoundingClientRect();
    setActive(index);
    setMenu({ index, at: point ?? { x: (rect?.left ?? 0) + 40, y: (rect?.bottom ?? 0) - 4 } });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const entry = entries[at]!;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const to = at + (event.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < total) {
        onMove(entry, to);
        setActive(Math.min(to, entries.length - 1));
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') onRemove(entry);
    else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') openMenu(at);
    else {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
      if (step) setActive(Math.max(0, Math.min(entries.length - 1, at + step)));
      else if (event.key === 'Home') setActive(0);
      else if (event.key === 'End') setActive(entries.length - 1);
      else return;
    }
    event.preventDefault();
  };
  const rowOf = (event: MouseEvent<HTMLUListElement> | DragEvent<HTMLUListElement>): number | null => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    return row ? Number(row.dataset['index']) : null;
  };
  const onClick = (event: MouseEvent<HTMLUListElement>): void => {
    const index = rowOf(event);
    if (index === null) return;
    setActive(index);
    const more = (event.target as HTMLElement).closest('[data-menu]');
    if (more) {
      const rect = more.getBoundingClientRect();
      openMenu(index, { x: rect.right - 8, y: rect.bottom + 2 });
    }
  };
  const onContextMenu = (event: MouseEvent<HTMLUListElement>): void => {
    const index = rowOf(event);
    if (index === null) return;
    event.preventDefault();
    openMenu(index, { x: event.clientX, y: event.clientY });
  };
  const onDrop = (event: DragEvent<HTMLUListElement>): void => {
    event.preventDefault();
    const to = rowOf(event);
    if (dragging !== null && to !== null && to !== dragging) onMove(entries[dragging]!, to);
    setDragging(null);
    setOver(null);
  };

  const shown = menu ? entries[menu.index] : null;
  const menuEntries = (index: number, entry: FolderPlaylistEntry): MenuEntry[] => {
    const link = entry.locationKind === 'url' ? entry.location : (entry.sources[0]?.url ?? null);
    return [
      { kind: 'item', label: 'Move Up', disabled: index === 0, onSelect: () => onMove(entry, index - 1) },
      { kind: 'item', label: 'Move Down', disabled: index >= total - 1, onSelect: () => onMove(entry, index + 1) },
      { kind: 'sep' },
      { kind: 'item', label: 'Open Its Link', disabled: !link, ...(link ? {} : { note: 'No link' }), onSelect: () => link && window.open(link, '_blank', 'noopener,noreferrer') },
      { kind: 'sep' },
      { kind: 'item', label: 'Remove from Playlist', onSelect: () => onRemove(entry) },
    ];
  };

  return (
    <div className="well">
      {/* The list box owns its keys (UX-KEY-001); drag is the pointer's way to do what Alt+↑/↓ does. */}
      <ul
        ref={list}
        className="rows mrows pl-rows"
        role="listbox"
        aria-label="Songs"
        tabIndex={0}
        aria-activedescendant={`${id}-${at}`}
        aria-describedby={`${id}-hint`}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(rowOf(event));
        }}
        onDrop={onDrop}
      >
        {entries.map((e, i) => (
          <li
            key={e.id}
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === at}
            data-index={i}
            draggable
            className={[dragging === i && 'is-dragging', over === i && dragging !== null && dragging !== i && 'is-over'].filter(Boolean).join(' ') || undefined}
            onDragStart={(event) => {
              setDragging(i);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', e.title);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
          >
            <span className="mrow__n">{i + 1}</span>
            <Mosaic covers={e.artworkUrl ? [e.artworkUrl] : []} />
            <span className="mrow__main">
              <span className="mrow__title">{e.title}</span>
              <span className="mrow__sub">{[e.artist, e.album].filter(Boolean).join(' · ')}</span>
              <span className={`mrow__sub pl-where pl-where--${e.locationKind}`}>{whereText(e)}</span>
            </span>
            <span className="mrow__meta">
              <span className="mrow__time">{e.durationSec !== null ? formatDuration(e.durationSec * 1000) : ''}</span>
            </span>
            <span className="mrow__more" data-menu title="More: move, open its link, remove (Shift+F10)" aria-hidden="true">
              …
            </span>
          </li>
        ))}
      </ul>
      <span className="sr" id={`${id}-hint`}>
        Alt+Up and Alt+Down move the highlighted song. Delete takes it out of the playlist. Shift+F10 or the Menu key opens its menu.
      </span>
      {menu && shown ? (
        <Menu
          label={`“${shown.title}”`}
          at={menu.at}
          entries={menuEntries(menu.index, shown)}
          onClose={(refocus) => {
            if (refocus) list.current?.focus();
            setMenu(null);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ sheets */

function NameSheet({ title, verb, initial, onSave, onCancel }: { title: string; verb: string; initial: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const nameId = useId();
  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
    } catch (err) {
      setError(asApiError(err));
      setBusy(false);
    }
  };
  return (
    <Sheet title={title} onCancel={onCancel}>
      <div className="pref">
        <label className="k" htmlFor={nameId}>
          Name:
        </label>
        <div className="v">
          <Field id={nameId} value={name} maxLength={120} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && void save()} />
        </div>
      </div>
      <ActionError error={error} />
      <div className="sheet__acts">
        <Push onClick={onCancel}>Cancel</Push>
        <Push primary busy={busy} disabled={!name.trim()} reason="Type a name first." onClick={() => void save()}>
          {verb}
        </Push>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ the folder */

function FolderGroup({ folder, onChanged }: { folder: PlaylistFolderInfo | null; onChanged: () => void }) {
  const { present, say } = useHubUi();
  const change = (): void => {
    if (!folder) return;
    present(
      <FolderSheet
        folder={folder}
        onCancel={() => present(null)}
        onDone={(text) => {
          present(null);
          onChanged();
          say(text);
        }}
      />,
    );
  };
  return (
    <Group title="Playlist folder" hint="Where the hub keeps its playlists: a folder inside its data volume, under playlists or library. A folder beside the music keeps every song’s path short.">
      <div className="pref">
        <span className="k">Folder:</span>
        <div className="v">
          <code className="pl-folder">{folder?.path ?? '…'}</code>
          {folder?.isDefault ? <span className="sub"> (the default)</span> : null}
        </div>
        <span className="k">Holds:</span>
        <div className="v">{folder ? count(folder.playlistCount, 'playlist') : '…'}</div>
      </div>
      <div className="barrow">
        <Push onClick={change} disabled={!folder}>
          Change…
        </Push>
      </div>
    </Group>
  );
}

function FolderSheet({ folder, onDone, onCancel }: { folder: PlaylistFolderInfo; onDone: (text: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(folder.relativePath ?? 'playlists');
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const pathId = useId();
  const base = folder.path.slice(0, folder.path.length - (folder.relativePath?.length ?? 0)).replace(/\/$/, '');
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const done = await api('playlistsFolderPut', { body: { relativePath: path, move: move && folder.playlistCount > 0 } });
      const moved = done.moved ? ` Moved ${count(done.moved, 'playlist')} there.` : '';
      const failed = done.failed.length ? ` ${count(done.failed.length, 'playlist')} couldn’t be moved: ${done.failed.join(', ')}.` : '';
      onDone(`Playlists are kept in ${done.folder.path} now.${moved}${failed}`);
    } catch (err) {
      setError(asApiError(err));
      setBusy(false);
    }
  };
  return (
    <Sheet title="Keep playlists somewhere else" onCancel={onCancel}>
      <div className="pref">
        <label className="k" htmlFor={pathId}>
          Folder:
        </label>
        <div className="v">
          <Field id={pathId} mono value={path} onChange={(event) => setPath(event.currentTarget.value)} aria-describedby={`${pathId}-hint`} onKeyDown={(event) => event.key === 'Enter' && void save()} />
          <p className="hint" id={`${pathId}-hint`}>
            Inside {base || 'the data volume'}: “playlists”, “playlists/Family” or “library/Playlists”.
          </p>
        </div>
      </div>
      {folder.playlistCount > 0 ? (
        <Check checked={move} onChange={setMove}>
          Move the {count(folder.playlistCount, 'playlist')} there too
        </Check>
      ) : null}
      <ActionError error={error} />
      <div className="sheet__acts">
        <Push onClick={onCancel}>Cancel</Push>
        <Push primary busy={busy} disabled={!path.trim()} onClick={() => void save()}>
          Use This Folder
        </Push>
      </div>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ the players' copies */

function SharedFromPlayers() {
  const sources = useResource('sharesSources', {}, { pollMs: 60_000 });
  const playlists = (sources.data as ShareSources | null)?.playlists ?? [];
  const state = listState(sources, (d) => (d as ShareSources).playlists.length === 0, 'None yet. A player’s playlists arrive once it syncs to the hub.');
  return (
    <Group title="Shared from players" hint="Copies of the playlists paired players sync to the hub. They stay the players’: the hub reads them and can make a shared link to one (Sharing), but never changes them." last>
      <div className="well">
        <ul className="rows" aria-label="Shared from players">
          {state ? (
            <li>
              <span className="empty">{state.text}</span>
            </li>
          ) : (
            playlists.map((p) => (
              <li key={p.id}>
                <span className="name">{p.name}</span>
                <span className="sub">{count(p.trackCount, 'song')}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </Group>
  );
}
