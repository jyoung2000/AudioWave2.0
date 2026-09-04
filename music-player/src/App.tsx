/**
 * The player shell.
 *
 * One window, a source list, a toolbar carrying the transport and the LCD display, and a status
 * bar — the Aqua/iTunes 9 arrangement the design spec describes (§§9.1–9.12), not a reinterpretation
 * of it.
 *
 * The transport row carries the Star, Add-to-Playlist and Share controls beside the play controls,
 * because acting on the song you are listening to should not require navigating away from it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AquaWindow,
  BottomBar,
  Button,
  Content,
  Glyph,
  IconButton,
  LcdDisplay,
  Scrubber,
  SearchField,
  SourceList,
  StatusDot,
  Toolbar,
  Transport,
  VolumeSlider,
  WorkArea,
  useToast,
  type SourceGroup,
} from '@now-playing/aqua-ui';
import { formatTime, useAppState, usePlayer } from './state/context.js';
import { LibraryView } from './views/Library.js';
import { NowPlayingView } from './views/NowPlaying.js';
import { QueueView } from './views/Queue.js';
import { PlaylistsView } from './views/Playlists.js';
import { EqualiserView } from './views/Equaliser.js';
import { MetricsView } from './views/Metrics.js';
import { ConstellationView } from './views/Constellation.js';
import { SearchView } from './views/Search.js';
import { SettingsView } from './views/Settings.js';
import { AddToPlaylistSheet } from './components/AddToPlaylistSheet.js';
import { ShareSheet } from './components/ShareSheet.js';
import { NoticeBar } from './components/NoticeBar.js';

export type ViewId = 'library' | 'now-playing' | 'queue' | 'playlists' | 'search' | 'equaliser' | 'metrics' | 'constellation' | 'settings';

export function App() {
  const { store, hubStatus } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [view, setView] = useState<ViewId>('library');
  const [query, setQuery] = useState('');
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const entry = state.queue[state.queueIndex] ?? null;
  const currentTrack = entry ? state.library.tracks.find((t) => t.id === entry.track.trackId) ?? null : null;
  const playing = state.playback.status === 'playing';

  const groups = useMemo<SourceGroup<ViewId>[]>(
    () => [
      {
        id: 'library',
        label: 'Library',
        items: [
          { id: 'library', label: 'Music', icon: <Glyph name="note" />, count: state.library.tracks.length },
          { id: 'now-playing', label: 'Now playing', icon: <Glyph name="play" /> },
          { id: 'queue', label: 'Up next', icon: <Glyph name="sort" />, count: Math.max(0, state.queue.length - state.queueIndex - 1) },
          { id: 'playlists', label: 'Playlists', icon: <Glyph name="folder" />, count: state.playlists.length },
        ],
      },
      {
        id: 'discover',
        label: 'Discover',
        items: [
          { id: 'search', label: 'Search', icon: <Glyph name="search" />, status: hubStatus.connected ? null : 'Searches this device only until a hub is paired' },
          { id: 'constellation', label: 'Constellation', icon: <Glyph name="star" /> },
          { id: 'metrics', label: 'Listening', icon: <Glyph name="history" /> },
        ],
      },
      {
        id: 'sound',
        label: 'Sound',
        items: [
          { id: 'equaliser', label: 'Equaliser', icon: <Glyph name="eq" />, status: state.resolvedEq.presetName },
          { id: 'settings', label: 'Settings', icon: <Glyph name="gear" /> },
        ],
      },
    ],
    [state.library.tracks.length, state.queue.length, state.queueIndex, state.playlists.length, state.resolvedEq.presetName, hubStatus.connected],
  );

  // Space toggles playback from anywhere that is not a text field, the way every player behaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void store.playback.toggle();
      } else if (event.key === 'ArrowRight' && event.shiftKey) {
        void store.next('user');
      } else if (event.key === 'ArrowLeft' && event.shiftKey) {
        void store.previous();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const onSearch = useCallback(
    (value: string) => {
      setQuery(value);
      if (value.trim()) setView('search');
    },
    [],
  );

  const body = (() => {
    switch (view) {
      case 'library':
        return <LibraryView onOpenView={setView} />;
      case 'now-playing':
        return <NowPlayingView />;
      case 'queue':
        return <QueueView />;
      case 'playlists':
        return <PlaylistsView />;
      case 'search':
        return <SearchView query={query} onQueryChange={setQuery} />;
      case 'equaliser':
        return <EqualiserView />;
      case 'metrics':
        return <MetricsView />;
      case 'constellation':
        return <ConstellationView />;
      case 'settings':
        return <SettingsView />;
      default:
        return null;
    }
  })();

  const liked = currentTrack?.liked ?? false;

  return (
    <AquaWindow active title="Now Playing" flush>
      <Toolbar
        transport={
          <Transport
            playing={playing}
            onPlayPause={() => void store.playback.toggle()}
            onPrevious={() => void store.previous()}
            onNext={() => void store.next('user')}
            canPrevious={state.queueIndex > 0 || state.playback.positionMs > 3000}
            canNext={state.queueIndex < state.queue.length - 1 || state.repeat === 'all'}
            disabled={!entry}
            disabledReason={entry ? undefined : 'Nothing is queued yet'}
            shuffle={state.shuffle}
            onShuffle={() => void store.setShuffle(!state.shuffle)}
            repeat={state.repeat}
            onRepeat={() => void store.setRepeat(state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off')}
            leading={
              <IconButton
                icon="star"
                label={liked ? 'Remove from favourites' : 'Add to favourites'}
                pressed={liked}
                disabled={!currentTrack}
                onClick={() => {
                  if (currentTrack) void store.toggleLike(currentTrack.id);
                }}
              />
            }
            trailing={
              <>
                <IconButton icon="add" label="Add to a playlist" disabled={!entry} onClick={() => setAddToPlaylistOpen(true)} />
                <IconButton
                  icon="share"
                  label="Share this song"
                  disabled={!entry}
                  onClick={() => {
                    if (!hubStatus.connected) {
                      toast.show('Sharing needs a paired hub: the link has to be served by something other people can reach.', { kind: 'info' });
                      return;
                    }
                    setShareOpen(true);
                  }}
                />
              </>
            }
          />
        }
        display={
          <LcdDisplay
            title={entry?.track.title ?? 'Nothing playing'}
            detail={entry ? `${entry.track.artistName}${entry.track.albumName ? ` — ${entry.track.albumName}` : ''}` : state.library.tracks.length ? 'Choose something from your library' : 'Add a folder of music to begin'}
            status={
              state.playback.status === 'loading'
                ? { text: 'Loading…', percent: state.playback.buffered * 100 }
                : state.library.scanning
                  ? { text: `Scanning — ${state.library.scanning.indexed} of ${state.library.scanning.found}`, percent: state.library.scanning.found ? (state.library.scanning.indexed / state.library.scanning.found) * 100 : null }
                  : null
            }
            channel={
              <Scrubber
                positionMs={state.playback.positionMs}
                durationMs={state.playback.durationMs}
                onSeek={(ms) => store.playback.seek(ms)}
                disabled={!entry}
                label="Playback position"
              />
            }
          />
        }
        secondary={<VolumeSlider value={state.playback.volume} onChange={(v) => store.playback.setVolume(v)} muted={state.playback.muted} onToggleMute={() => store.playback.setMuted(!state.playback.muted)} />}
        search={<SearchField label="Search" value={query} onChange={onSearch} onEscape={() => setQuery('')} placeholder="Search your music" />}
      />

      <WorkArea sidebar={<SourceList groups={groups} selectedId={view} onSelect={setView} label="Sections" dimUnfocused />} currentSourceName={groups.flatMap((g) => g.items).find((i) => i.id === view)?.label ?? 'Music'}>
        <Content>
          <NoticeBar />
          {body}
        </Content>
      </WorkArea>

      <BottomBar
        left={
          <Button size="mini" icon="add" onClick={() => void store.addDirectory()} ellipsis>
            Add music
          </Button>
        }
        status={statusLine(state, hubStatus.connected, hubStatus.hubName)}
        right={
          <span className="player-status-right">
            {state.playback.dspUnavailableReason ? <StatusDot kind="warning" label="EQ unavailable" /> : <StatusDot kind="ok" label={state.resolvedEq.presetName} />}
            <span className="player-time">{`${formatTime(state.playback.positionMs)} / ${formatTime(state.playback.durationMs)}`}</span>
          </span>
        }
      />

      <AddToPlaylistSheet open={addToPlaylistOpen} onClose={() => setAddToPlaylistOpen(false)} tracks={entry ? [entry.track] : []} />
      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} kind="track" track={entry?.track ?? null} />
    </AquaWindow>
  );
}

function statusLine(state: ReturnType<typeof useAppState>, hubConnected: boolean, hubName: string | null): string {
  const parts: string[] = [];
  parts.push(`${state.library.tracks.length} track${state.library.tracks.length === 1 ? '' : 's'}`);
  if (state.queue.length) parts.push(`${state.queue.length} queued`);
  parts.push(hubConnected ? `connected to ${hubName ?? 'a hub'}` : 'playing from this device');
  return parts.join(' · ');
}
