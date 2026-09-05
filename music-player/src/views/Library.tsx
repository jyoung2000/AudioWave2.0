/**
 * The library: everything indexed from folders on this device.
 *
 * The list itself is the reference's, verbatim — see `MusicList` in @now-playing/aqua-ui. This view is
 * what surrounds it: the ways music gets in, the actions that work on the whole list, and the
 * empty state.
 *
 * Two things it is careful about. A track the browser cannot decode is shown, not hidden, with the
 * reason attached — the file exists, and pretending otherwise makes the library look wrong. And the
 * empty state explains what "add a folder" actually does (index, not copy), because people are
 * reasonably wary of a web page asking for their music folder.
 */
import { useState } from 'react';
import { Button, EmptyState, Panel, useToast } from '@now-playing/aqua-ui';
import type { Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { ViewId } from '../App.js';
import { useAppState, usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';
import { MusicList } from '@now-playing/aqua-ui';
import { NewPlaylistSheet } from '../components/NewPlaylistSheet.js';

/**
 * Two destinations the section strip no longer carries when you are listening alone.
 *
 * The strip is four entries now and these are not among them — but "what is this song doing to the
 * audio chain" and "what else might I like" are still real screens, and a screen you cannot reach
 * may as well not exist. They sit under the library because the library is where a solo session
 * lives, and in *both* of its states: an empty library is exactly when someone is most likely to go
 * looking for something else.
 */
function MoreDestinations({ onOpenView }: { onOpenView: (view: ViewId) => void }) {
  return (
    <p className="player-links">
      <button type="button" className="player-link" onClick={() => onOpenView('now-playing')}>
        Now playing
      </button>
      <button type="button" className="player-link" onClick={() => onOpenView('constellation')}>
        Constellation
      </button>
    </p>
  );
}

export function LibraryView({ onOpenView }: { onOpenView: (view: ViewId) => void }) {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [newList, setNewList] = useState<{ open: boolean; track: Track | null }>({ open: false, track: null });

  const playFrom = (track: Track, ordered: readonly Track[]): void => {
    if (track.unsupportedReason) {
      toast.show(track.unsupportedReason, { kind: 'warning' });
      return;
    }
    store.setQueue(
      ordered.map((row) => ({ id: uuidv7(), track: toTrackRef(row), context: { kind: 'library' as const, id: null, name: 'your library' } })),
      ordered.indexOf(track),
    );
  };

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
        <MoreDestinations onOpenView={onOpenView} />
      </Panel>
    );
  }

  const first = state.library.tracks[0];

  return (
    <>
      <div className="np-section-head">
        <h2>Music</h2>
        <p>
          {state.library.tracks.length} {state.library.tracks.length === 1 ? 'track' : 'tracks'} indexed from folders on this device
        </p>
      </div>

      <div className="np-toolbar-row">
        <Button size="small" icon="play" disabled={!first} onClick={() => first && playFrom(first, state.library.tracks)}>
          Play all
        </Button>
        <Button
          size="small"
          icon="shuffle"
          onClick={() => {
            void store.setShuffle(true);
            const pick = state.library.tracks[Math.floor(Math.random() * state.library.tracks.length)];
            if (pick) playFrom(pick, state.library.tracks);
          }}
        >
          Shuffle all
        </Button>
        {/* The old shell kept these in a bottom bar. A page has no bottom bar, and "add more music"
            belongs beside the library it adds to. */}
        <Button size="small" icon="add" onClick={() => void store.addDirectory()} ellipsis>
          Add a folder
        </Button>
        <Button size="small" onClick={() => pickFiles(store)} ellipsis>
          Choose files
        </Button>
      </div>

      <MoreDestinations onOpenView={onOpenView} />

      <MusicList
        label="Your music"
        tracks={state.library.tracks}
        playingTrackId={state.queue[state.queueIndex]?.track.trackId ?? null}
        onPlay={playFrom}
        onToggleStar={(track) => void store.toggleLike(track.id)}
        playlists={state.playlists}
        playlistItems={state.playlistItems}
        onTogglePlaylist={(track, playlistId) => {
          const existing = state.playlistItems.find((item) => item.playlistId === playlistId && item.track.trackId === track.id);
          const playlist = state.playlists.find((list) => list.id === playlistId);
          if (existing) {
            void store.removeFromPlaylist(existing.id);
            toast.show(`Removed from “${playlist?.name ?? 'the playlist'}”`);
          } else {
            void store.addToPlaylist(playlistId, [toTrackRef(track)]);
            toast.show(`Added to “${playlist?.name ?? 'the playlist'}”`);
          }
        }}
        onNewPlaylist={(track) => setNewList({ open: true, track })}
        onSay={(message) => toast.show(message)}
        ephemeralTrackIds={state.library.ephemeralTrackIds}
      />

      <NewPlaylistSheet
        open={newList.open}
        seedTitle={newList.track?.title ?? null}
        onCancel={() => setNewList({ open: false, track: null })}
        onCreate={(name) => {
          void store.createPlaylist(name, newList.track ? [toTrackRef(newList.track)] : []);
          toast.show(newList.track ? `Added to “${name}”` : `Created “${name}”`);
          setNewList({ open: false, track: null });
        }}
      />
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
