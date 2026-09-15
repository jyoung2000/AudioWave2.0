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
import { Suspense, lazy, useState } from 'react';
import { Button, EmptyState, Panel, useToast } from '@now-playing/aqua-ui';
import type { Track } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { ViewId } from '../App.js';
import { useAppState, usePlayer } from '../state/context.js';
import { toTrackRef } from '../state/store.js';
import { supportsDirectoryHandles } from '../lib/library.js';
import { MusicList } from '@now-playing/aqua-ui';
import { NewPlaylistSheet } from '../components/NewPlaylistSheet.js';

/** Only ever opened by someone running a helper, so it travels separately from the first load. */
const FetchSheet = lazy(() => import('../components/FetchSheet.js').then((m) => ({ default: m.FetchSheet })));

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

export function LibraryView({ onOpenView, onDownload }: { onOpenView: (view: ViewId) => void; onDownload: (track: Track) => void }) {
  const { store } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [newList, setNewList] = useState<{ open: boolean; track: Track | null }>({ open: false, track: null });
  const [fetchOpen, setFetchOpen] = useState(false);
  // The button exists only while a helper is actually answering with a tool it can run. An action
  // that would fail is not an action worth drawing.
  const canFetch = Boolean(state.tools?.health.tools.some((tool) => tool.id !== 'ffmpeg' && tool.present));

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
          text={`${
            supportsDirectoryHandles()
              ? 'Add a folder of music from this device. The player reads the files where they are — nothing is copied, uploaded or moved, and your folders are never sent anywhere.'
              : state.library.keepCopies && !state.library.copiesReason
                ? 'Choose music from this device. The player keeps a copy of each file inside the app, so your music plays offline and is still here after a reload. Nothing is uploaded anywhere.'
                : 'Choose music from this device. The files play until you reload; nothing is uploaded anywhere.'
          } Music bought or exported from a platform — a Bandcamp purchase, a Google Takeout of your YouTube Music uploads — arrives as a .zip, and the player unpacks it for you.`}
          actions={
            supportsDirectoryHandles()
              ? [
                  { id: 'add', label: 'Add a folder', variant: 'default', onSelect: () => void store.addDirectory() },
                  { id: 'files', label: 'Choose files instead', onSelect: () => pickFiles(store) },
                  { id: 'zip', label: 'Import a .zip', onSelect: () => pickFiles(store, 'archives') },
                  ...(canFetch ? [{ id: 'link', label: 'Add from a link', onSelect: () => setFetchOpen(true) }] : []),
                ]
              : [
                  { id: 'files', label: 'Choose files', variant: 'default', onSelect: () => pickFiles(store) },
                  { id: 'zip', label: 'Import a .zip', onSelect: () => pickFiles(store, 'archives') },
                  ...(canFetch ? [{ id: 'link', label: 'Add from a link', onSelect: () => setFetchOpen(true) }] : []),
                ]
          }
          {...(state.library.directoryHandleReason ? { details: { summary: 'About this browser', text: state.library.directoryHandleReason } } : {})}
        />
        <MoreDestinations onOpenView={onOpenView} />
        <Suspense fallback={null}>{fetchOpen ? <FetchSheet open onClose={() => setFetchOpen(false)} /> : null}</Suspense>
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
        {supportsDirectoryHandles() ? (
          <Button size="small" icon="add" onClick={() => void store.addDirectory()} ellipsis>
            Add a folder
          </Button>
        ) : null}
        <Button size="small" icon={supportsDirectoryHandles() ? undefined : 'add'} onClick={() => pickFiles(store)} ellipsis>
          Choose files
        </Button>
        <Button size="small" onClick={() => pickFiles(store, 'archives')} ellipsis>
          Import a .zip
        </Button>
        {canFetch ? (
          <Button size="small" onClick={() => setFetchOpen(true)} ellipsis>
            Add from a link
          </Button>
        ) : null}
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
        onDownload={(track) => onDownload(track)}
        onPlaySimilar={(track) => {
          void (async () => {
            const result = await store.playSimilarTo(track);
            toast.show(result.ok ? `Playing music like ${track.title}` : (result.reason ?? 'Nothing similar to play.'), result.ok ? undefined : { kind: 'warning' });
          })();
        }}
      />

      <Suspense fallback={null}>{fetchOpen ? <FetchSheet open onClose={() => setFetchOpen(false)} /> : null}</Suspense>

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

/**
 * The file picker. It takes archives as well as audio, because that is how music arrives from every
 * platform that will legitimately give you your own: a Bandcamp purchase, a Google Takeout of your
 * YouTube Music uploads, a set of downloadable SoundCloud tracks. Unzipping first is a chore on a
 * desktop and close to impossible on a phone, which is exactly where those downloads land.
 *
 * @param only Restricts the picker to archives, for the button that says it takes one.
 */
export function pickFiles(store: ReturnType<typeof usePlayer>['store'], only?: 'archives'): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = only === 'archives' ? '.zip,application/zip' : 'audio/*,.zip,application/zip';
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    // Only pay for the unpacker when there is something to unpack.
    if (files.some((file) => file.name.toLowerCase().endsWith('.zip'))) void store.importArchives(files);
    else void store.addFiles(files);
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
