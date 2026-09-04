/**
 * The library: everything indexed from folders on this device.
 *
 * Two things the list is careful about. A track the browser cannot decode is shown, not hidden, with
 * the reason attached — the file exists, and pretending otherwise makes the library look wrong. And
 * the empty state explains what "add a folder" actually does (index, not copy), because people are
 * reasonably wary of a web page asking for their music folder.
 */
import { useMemo, useState } from 'react';
import { AquaTable, Button, EmptyState, Panel, StatusDot, useToast, type SortDirection } from '@now-playing/aqua-ui';
import type { Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { ViewId } from '../App.js';
import { useAppState, usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';
import { AddToPlaylistSheet } from '../components/AddToPlaylistSheet.js';

export function LibraryView({ onOpenView }: { onOpenView: (view: ViewId) => void }) {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: 'artist', direction: 'ascending' });

  const rows = useMemo(() => {
    const sorted = [...state.library.tracks];
    const key = (track: Track): string => {
      switch (sort.columnId) {
        case 'title':
          return track.title.toLowerCase();
        case 'album':
          return `${(track.albumName ?? '').toLowerCase()}|${String(track.discNumber ?? 0).padStart(3, '0')}|${String(track.trackNumber ?? 0).padStart(4, '0')}`;
        case 'year':
          return String(track.year ?? 0).padStart(6, '0');
        default:
          return `${track.artistName.toLowerCase()}|${(track.albumName ?? '').toLowerCase()}|${String(track.trackNumber ?? 0).padStart(4, '0')}`;
      }
    };
    sorted.sort((a, b) => (sort.direction === 'ascending' ? key(a).localeCompare(key(b)) : key(b).localeCompare(key(a))));
    return sorted;
  }, [state.library.tracks, sort]);

  const playFrom = (index: number): void => {
    store.setQueue(
      rows.map((track) => ({ id: uuidv7(), track: toTrackRef(track), context: { kind: 'library' as const, id: null, name: 'your library' } })),
      index,
    );
  };

  const selectedTracks = rows.filter((t) => selected.has(t.id)).map(toTrackRef);

  if (!state.library.tracks.length) {
    return (
      <Panel>
        <EmptyState
          title="No music yet"
          text="Add a folder of music from this device. The player reads the files where they are — nothing is copied, uploaded or moved, and your folders are never sent anywhere."
          actions={[
            { id: 'add', label: 'Add a folder', variant: 'default', onSelect: () => void store.addDirectory() },
            { id: 'files', label: 'Choose files instead', onSelect: () => pickFiles(store) },
          ]}
          {...(state.library.directoryHandleReason ? { details: { summary: 'About this browser', text: state.library.directoryHandleReason } } : {})}
        />
      </Panel>
    );
  }

  return (
    <>
      <div className="np-section-head">
        <h2>Music</h2>
        <p>
          {rows.length} {rows.length === 1 ? 'track' : 'tracks'} indexed from folders on this device
        </p>
      </div>
      <Panel>
        <div className="player-toolbar-row">
          <Button size="small" icon="play" disabled={!rows.length} onClick={() => playFrom(0)}>
            Play all
          </Button>
          <Button
            size="small"
            icon="shuffle"
            disabled={!rows.length}
            onClick={() => {
              void store.setShuffle(true);
              playFrom(Math.floor(Math.random() * rows.length));
            }}
          >
            Shuffle all
          </Button>
          <Button size="small" icon="add" disabled={selected.size === 0} onClick={() => setSheetOpen(true)} ellipsis>
            {selected.size ? `Add ${selected.size} to playlist` : 'Add to playlist'}
          </Button>
          <Button size="small" icon="sort" onClick={() => onOpenView('queue')}>
            Up next
          </Button>
          {/* The old shell kept this in a bottom bar. A page has no bottom bar, and "add more music"
              belongs beside the library it adds to. */}
          <Button size="small" icon="add" onClick={() => void store.addDirectory()} ellipsis>
            Add a folder
          </Button>
          <Button size="small" onClick={() => pickFiles(store)} ellipsis>
            Choose files
          </Button>
        </div>

        <AquaTable
          variant="page"
          height="min(58vh, 520px)"
          label="Your music"
          rowKey={(row: Track) => row.id}
          rows={rows}
          sort={sort}
          onSortChange={(columnId, direction) => setSort({ columnId, direction })}
          selectedKeys={selected}
          onSelectionChange={(keys) => setSelected(keys)}
          onActivate={(row) => playFrom(rows.indexOf(row))}
          currentKey={state.queue[state.queueIndex]?.track.trackId ?? null}
          columns={[
            {
              id: 'like',
              header: (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z" />
                </svg>
              ),
              headerLabel: 'Favourite',
              align: 'center',
              width: 30,
              cell: (row) => (
                <button type="button" className="np-list__btn" aria-pressed={row.liked} aria-label={row.liked ? `Remove ${row.title} from favourites` : `Add ${row.title} to favourites`} onClick={() => void store.toggleLike(row.id)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d={row.liked ? 'M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.5 6.1 20.6l1.2-6.5L2.5 9.5l6.6-.9z' : 'M12 2.8l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.7l-5.9 3.1 1.2-6.5L2.5 9.7l6.6-.9zm0 4.5-1.7 3.5-3.8.5 2.8 2.7-.7 3.8 3.4-1.8 3.4 1.8-.7-3.8 2.8-2.7-3.8-.5z'} />
                  </svg>
                </button>
              ),
            },
            {
              id: 'title',
              header: 'Title',
              primary: true,
              sortable: true,
              /*
               * The "cannot be decoded here" marker rides in the title cell rather than in a column
               * of its own. As a column it was ninety pixels of empty space on every row of a
               * healthy library, which reads as a rendering fault; beside the title it is where the
               * eye already is on the one row that needs it.
               */
              cell: (row) =>
                row.unsupportedReason ? (
                  <span className="player-inline-status" title={row.unsupportedReason}>
                    {row.title} <StatusDot kind="warning" label="Not playable here" />
                  </span>
                ) : (
                  row.title
                ),
              stackText: (row) => row.artistName,
            },
            { id: 'artist', header: 'Artist', sortable: true, cell: (row) => row.artistName },
            { id: 'album', header: 'Album', sortable: true, cell: (row) => row.albumName ?? '' },
            { id: 'year', header: 'Year', align: 'right', width: 56, sortable: true, cell: (row) => row.year ?? '' },
            { id: 'time', header: 'Time', align: 'right', width: 56, cell: (row) => formatDuration(row.durationMs) },
          ]}
          onContextMenu={(row) => {
            if (row.unsupportedReason) toast.show(row.unsupportedReason, { kind: 'warning' });
          }}
        />
      </Panel>
      <AddToPlaylistSheet open={sheetOpen} onClose={() => setSheetOpen(false)} tracks={selectedTracks} />
    </>
  );
}

function pickFiles(store: ReturnType<typeof usePlayer>['store']): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'audio/*';
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length) void store.addFiles(files);
  };
  input.click();
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}
