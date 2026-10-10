/**
 * Library ▸ Playlists (DEC-041; CMP-PL-001…CMP-PL-006): the playlists this PC keeps as files in its
 * playlist folder (`Music\Airwave Playlists` unless Settings ▸ Playlists chose another), and that
 * folder's own group for Settings.
 *
 * - **The list** (CMP-PL-005): a row per playlist with its 2×2 mosaic, its name and "12 songs ·
 *   48 min"; one tab stop, the arrows move, Enter or a click opens it like an album (UX-SEARCH-004). A
 *   list someone dropped into the folder says it was made outside Airwave.
 * - **A playlist**: its head (mosaic, name, length) with Rename…, Export… and Delete… (asked first),
 *   then its songs. A song moves by drag, or by Alt+↑/↓; Delete takes it out; its "…", a right-click,
 *   Shift+F10, or a long press on touch (CMP-PL-006) open its menu.
 * - **The folder** (CMP-PL-001, in Settings): where the files are, Change… (the system's folder
 *   picker, with the playlists moved along when "Move my playlists" is ticked) and Open Folder.
 *
 * A list changed on disk by another player shows up by itself: the main process watches the folder
 * (`event:playlists-changed`), and every read rescans it.
 */
import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { FolderPlaylistEntry, FolderPlaylistPage, FolderPlaylistSummary, PlaylistFolderInfo } from '@now-playing/contracts';
import { formatDuration } from '@now-playing/domain/catalog';
import { invoke } from '../bridge.js';
import { plural } from '../format.js';
import { useChannel, useEvent } from '../hooks.js';
import { useLongPress } from '../long-press.js';
import { Menu, type MenuAt, type MenuEntry } from '../menu.js';
import { companionPlaylists, lengthText, playlistSummaryLine, whereText } from '../playlists.js';
import { ActionError, Check, Field, Group, Note, Push, Sheet, SearchUiProvider, useSearchUi } from '../search-kit.js';
import { useConfirm } from '../ui.js';

/** Songs a playlist page asks for at a time. */
const ENTRY_PAGE = 200;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** A playlist's cover: the mosaic of its first four songs' artwork, or the empty tile. */
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
  return (
    <SearchUiProvider>
      <PlaylistsPane />
    </SearchUiProvider>
  );
}

function PlaylistsPane() {
  const list = useChannel('playlists:list', {});
  const [openId, setOpenId] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  const { present, say } = useSearchUi();
  useEvent('event:playlists-changed', () => {
    list.reload();
    setChanged((n) => n + 1);
  });
  const data = list.data;

  const newPlaylist = (): void => {
    present(
      <NameSheet
        title="New Playlist"
        verb="Create"
        initial=""
        onCancel={() => present(null)}
        onSave={async (name) => {
          const made = await companionPlaylists.create(name);
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
        key={`${openId}-${changed}`}
        id={openId}
        onBack={() => {
          setOpenId(null);
          list.reload();
        }}
      />
    );
  }

  const items = data?.items ?? [];
  return (
    <Group title="Playlists" hint={data ? <>Kept as .m3u8 files in <span className="path">{data.folder.path}</span>, one per playlist, that any player can open. Lists put in that folder by hand show up here too.</> : 'Kept as .m3u8 files in this PC’s playlist folder, one per playlist.'}>
      {!data || !items.length ? (
        <div className="well">
          <ul className="rows" aria-label="Playlists">
            <li>
              <span className="empty">{list.error ?? (data ? 'No playlists yet. Make one here, or from Search: a song’s … ▸ Add to Playlist ▸ New Playlist….' : 'Loading…')}</span>
            </li>
          </ul>
        </div>
      ) : (
        <PlaylistIndex items={items} onOpen={(p) => setOpenId(p.id)} />
      )}
      {data && !data.folder.available ? <Note bad>{data.folder.reason}</Note> : null}
      {data?.folder.capped ? <Note>The folder holds more playlists than the companion reads (1,000). The rest are left alone.</Note> : null}
      <div className="barrow">
        <Push onClick={newPlaylist}>New Playlist…</Push>
      </div>
    </Group>
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
  const { present, say } = useSearchUi();
  const confirm = useConfirm();
  const [page, setPage] = useState<FolderPlaylistPage | null>(null);
  const [entries, setEntries] = useState<FolderPlaylistEntry[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Read when it opens (its heading takes the focus), and again after every change.
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    companionPlaylists.page(id, 0, ENTRY_PAGE).then(
      (first) => {
        if (!live) return;
        setPage(first);
        setEntries(first.items);
        setError(null);
        if (reads === 0) heading.current?.focus();
      },
      (err: unknown) => {
        if (live) setError(asError(err));
      },
    );
    return () => {
      live = false;
    };
  }, [id, reads]);

  const more = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await companionPlaylists.page(id, entries.length, ENTRY_PAGE);
      setEntries((e) => [...e, ...next.items]);
      setPage({ ...next, items: [] });
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = page?.playlist ?? null;
  const total = page?.total ?? 0;

  const act = async (work: () => Promise<FolderPlaylistSummary>, said: string): Promise<void> => {
    try {
      await work();
      reload();
      say(said);
    } catch (err) {
      say(asError(err).message);
    }
  };
  const move = (entry: FolderPlaylistEntry, to: number): void => {
    if (to < 0 || to >= total) return;
    void act(() => companionPlaylists.move(id, entry.id, to), `Moved “${entry.title}” to number ${to + 1}.`);
  };
  const removeEntry = (entry: FolderPlaylistEntry): void => void act(() => companionPlaylists.removeEntries(id, [entry.id]), `Took “${entry.title}” out of “${summary?.name ?? 'the playlist'}”.`);

  const rename = (): void => {
    if (!summary) return;
    present(
      <NameSheet
        title={`Rename “${summary.name}”`}
        verb="Rename"
        initial={summary.name}
        onCancel={() => present(null)}
        onSave={async (name) => {
          const renamed = await companionPlaylists.rename(id, name);
          present(null);
          reload();
          say(`Renamed to “${renamed.name}”; its file is ${renamed.fileName}.`);
        }}
      />,
    );
  };
  const exportIt = async (): Promise<void> => {
    try {
      const done = await companionPlaylists.exportFile(id);
      if (done.path) say(`Exported to ${done.path}.`);
      else if (done.reason) say(done.reason);
    } catch (err) {
      say(asError(err).message);
    }
  };
  const remove = async (): Promise<void> => {
    if (!summary) return;
    const yes = await confirm({ title: `Delete “${summary.name}”?`, detail: `Its .m3u8 file and its sidecar are deleted from the playlist folder. The ${plural(summary.entryCount, 'song')} stay in the library and at their sources.`, action: 'Delete', destructive: true });
    if (!yes) return;
    try {
      await companionPlaylists.remove(id);
      say(`Deleted “${summary.name}”.`);
      onBack();
    } catch (err) {
      say(asError(err).message);
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
                <Push onClick={() => void exportIt()}>Export…</Push>
                <Push onClick={() => void remove()}>Delete…</Push>
              </div>
            </div>
          </div>
          {summary.readOnly ? <Note>Made outside Airwave. It stays as it is until it is changed here; then the companion keeps a sidecar beside it.</Note> : null}
          <EntryList entries={entries} total={total} onMove={move} onRemove={removeEntry} />
          {entries.length < total ? (
            <div className="barrow">
              <Push busy={busy} onClick={() => void more()}>
                More Songs ({(total - entries.length).toLocaleString('en')} left)
              </Push>
            </div>
          ) : null}
          {summary.durationSec ? (
            <p className="note">
              {plural(total, 'song')}, {lengthText(summary.durationSec)} in all.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * A playlist's songs: one tab stop; the arrows, Home and End move; Alt+↑/↓ moves the highlighted
 * song; Delete takes it out; Shift+F10, the Menu key, a right-click, its "…" or a long press on touch
 * open its menu; a song can be dragged to another place.
 */
function EntryList({ entries, total, onMove, onRemove }: { entries: readonly FolderPlaylistEntry[]; total: number; onMove: (entry: FolderPlaylistEntry, to: number) => void; onRemove: (entry: FolderPlaylistEntry) => void }) {
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ index: number; at: MenuAt } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const at = Math.min(active, Math.max(0, entries.length - 1));
  const openMenu = (index: number, point?: MenuAt): void => {
    const row = list.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${index}`)}`);
    const rect = row?.getBoundingClientRect();
    setActive(index);
    setMenu({ index, at: point ?? { x: (rect?.left ?? 0) + 40, y: (rect?.bottom ?? 0) - 4 } });
  };
  const press = useLongPress<HTMLUListElement>((target, point) => {
    const row = target.closest<HTMLElement>('[data-index]');
    if (row) openMenu(Number(row.dataset['index']), point);
  });

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
    const moreButton = (event.target as HTMLElement).closest('[data-menu]');
    if (moreButton) {
      const rect = moreButton.getBoundingClientRect();
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
      { kind: 'item', label: 'Open Its Link', disabled: !link, ...(link ? {} : { note: 'No link' }), onSelect: () => link && void invoke('app:open-external', { url: link }) },
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
        {...press}
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
        Alt+Up and Alt+Down move the highlighted song. Delete takes it out of the playlist. Shift+F10, the Menu key or a long press opens its menu.
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
  const [error, setError] = useState<Error | null>(null);
  const nameId = useId();
  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim());
    } catch (err) {
      setError(asError(err));
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

/* ------------------------------------------------------------------ the folder, in Settings */

/**
 * Settings ▸ Playlists (CMP-PL-001): the folder, Change… (the system's own picker: the window never
 * names a path), Open Folder, and whether the playlists already kept go along when it changes.
 */
export function PlaylistFolderGroup({ say }: { say: (text: string) => void }) {
  const folder = useChannel('playlists:folder', undefined);
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const info: PlaylistFolderInfo | null = folder.data;
  const change = async (): Promise<void> => {
    setBusy(true);
    try {
      const done = await invoke('playlists:pick-dir', { move: move && (info?.playlistCount ?? 0) > 0 });
      folder.reload();
      if (done.reason) say(done.reason);
      else if (done.folder.path !== info?.path) {
        const moved = done.moved ? ` Moved ${plural(done.moved, 'playlist')} there.` : '';
        const failed = done.failed.length ? ` ${plural(done.failed.length, 'playlist')} couldn’t be moved: ${done.failed.join(', ')}.` : '';
        say(`Playlists are kept in ${done.folder.path} now.${moved}${failed}`);
      }
    } catch (err) {
      say(asError(err).message);
    } finally {
      setBusy(false);
    }
  };
  const open = async (): Promise<void> => {
    const done = await invoke('playlists:open-folder', undefined);
    if (!done.ok) say(done.reason ?? 'The folder couldn’t be opened.');
  };
  return (
    <fieldset>
      <legend>Playlists</legend>
      <div className="pref">
        <span className="k top" id="playlists-dir-k">
          Keep in:
        </span>
        <div className="v">
          {info ? (
            <span className="path" id="playlists-dir" aria-labelledby="playlists-dir-k playlists-dir">
              {info.path}
            </span>
          ) : (
            <span className="dim"> </span>
          )}
          <Push busy={busy} disabled={!info} onClick={() => void change()}>
            Change…
          </Push>
          <Push disabled={!info} onClick={() => void open()}>
            Open Folder
          </Push>
          <span className="sub">
            {info?.isDefault ? 'Airwave Playlists, in your Music folder. ' : ''}One .m3u8 per playlist that any player can open, with an .airwave.json beside it. {info ? `${plural(info.playlistCount, 'playlist')} there now.` : ''}
          </span>
        </div>
        <span className="k" aria-hidden="true" />
        <div className="v">
          <Check checked={move} disabled={!info || info.playlistCount === 0} onChange={setMove}>
            Move my playlists when the folder changes
          </Check>
        </div>
      </div>
      {info && !info.available ? <Note bad>{info.reason}</Note> : null}
    </fieldset>
  );
}
