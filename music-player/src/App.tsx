/**
 * The player shell: one page, not one window.
 *
 * The old shell was a faithful Aqua desktop window — title bar, source list down the left side, a
 * chrome toolbar carrying the transport, a status bar along the bottom. It is a good reconstruction
 * of iTunes 9 and the wrong shape for what this is: an app opened on a phone as often as on a
 * laptop, mostly to look at one song.
 *
 * `docs/reference/now-playing-header.html` shows the other shape and this follows it — a sticky
 * status bar, a hero player, and an iTunes 10 list underneath. `docs/UI_REDESIGN.md` maps every
 * feature from the old arrangement to this one, section by section, so "everything transferred" is
 * checkable rather than asserted.
 *
 * Two things deliberately did *not* change. The nine sections keep their names and their
 * accessible structure — a `navigation` landmark called "Sections" holding `option`s — because a
 * person who learned the app by keyboard or screen reader should not have to learn it twice; only
 * the pixels moved. And the transport row still carries Star, Add to playlist and Share beside the
 * play controls, because acting on the song you are hearing should not mean navigating away
 * from it.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarClock,
  BarSearch,
  Glyph,
  Hero,
  HeroArt,
  KeyButton,
  KeyTransport,
  LevelSlider,
  LoadingState,
  ModeSwitch,
  PageBar,
  ProfileButton,
  SectionStrip,
  StatusDot,
  TrackScrubber,
  useToast,
  type SectionItem,
} from '@now-playing/aqua-ui';
import { formatTime, useAppState, usePlayer } from './state/context.js';
import { LibraryView } from './views/Library.js';
import { NowPlayingView } from './views/NowPlaying.js';
import { QueueView } from './views/Queue.js';

/*
 * The six sections nobody opens first are code-split.
 *
 * Music, Now playing and Up next are the path someone takes to hear something, so they stay in the
 * first load. The equaliser's curve maths, the metrics charts, the constellation, the settings
 * panels, the playlist editor and the provider search are all real code that most sessions never
 * reach — and the bundle budget in tests/perf is what turned that observation into a rule.
 */
const PlaylistsView = lazy(async () => ({ default: (await import('./views/Playlists.js')).PlaylistsView }));
const EqualiserView = lazy(async () => ({ default: (await import('./views/Equaliser.js')).EqualiserView }));
const MetricsView = lazy(async () => ({ default: (await import('./views/Metrics.js')).MetricsView }));
const ConstellationView = lazy(async () => ({ default: (await import('./views/Constellation.js')).ConstellationView }));
const SearchView = lazy(async () => ({ default: (await import('./views/Search.js')).SearchView }));
const SettingsView = lazy(async () => ({ default: (await import('./views/Settings.js')).SettingsView }));
import { AddToPlaylistSheet } from './components/AddToPlaylistSheet.js';
import { ShareSheet } from './components/ShareSheet.js';
import { NoticeBar } from './components/NoticeBar.js';
import { SearchPopover, type SearchPopoverHandle } from './components/SearchPopover.js';
import { SharedStrip } from './components/Shared.js';
import { JewelStage } from './components/JewelStage.js';
import { toTrackRef } from './state/store.js';
import { offlineOf } from './lib/track-source.js';
import { uuidv7 } from '@now-playing/domain';

export type ViewId = 'library' | 'now-playing' | 'queue' | 'playlists' | 'search' | 'equaliser' | 'metrics' | 'constellation' | 'settings';

export function App() {
  const { store, hubStatus, shared, mode, setMode } = usePlayer();
  const state = useAppState();
  const toast = useToast();
  const [view, setView] = useState<ViewId>('library');
  const [query, setQuery] = useState('');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const popover = useRef<SearchPopoverHandle | null>(null);
  const [addToPlaylistOpen, setAddToPlaylistOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const entry = state.queue[state.queueIndex] ?? null;
  const currentTrack = entry ? (state.library.tracks.find((t) => t.id === entry.track.trackId) ?? null) : null;
  const playing = state.playback.status === 'playing';
  const [artwork, setArtwork] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  /*
   * What the jewel case shows. The sleeve and the disc label are the track's own cover when it has
   * one; the tray card lists the rest of the album, which is why this reaches into the library
   * rather than using the queue entry alone.
   */
  const stageAlbum = useMemo(() => {
    if (!entry) return null;
    const albumName = entry.track.albumName;
    const siblings = albumName ? state.library.tracks.filter((track) => track.albumName === albumName && track.artistName === entry.track.artistName) : [];
    return {
      title: entry.track.title,
      artist: entry.track.artistName,
      album: albumName,
      coverUrl: artwork,
      tracks: (siblings.length ? siblings : state.library.tracks.slice(0, 8)).map((track) => track.title),
      mood: mode === 'shared' ? ('shared' as const) : ('solo' as const),
    };
  }, [entry, state.library.tracks, artwork, mode]);

  /*
   * In shared mode the queue belongs to the hub, and following it means not seeking your own copy:
   * a broadcast has one position and it is not yours to drag. The scrubber says so rather than
   * silently ignoring the gesture.
   */
  const following = mode === 'shared' && shared.group !== null && shared.playback?.status === 'playing';

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void store.artworkUrl(entry?.track.artworkId ?? null).then((next) => {
      if (cancelled) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      url = next;
      setArtwork(next);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry?.track.artworkId, store]);

  const sections = useMemo<SectionItem<ViewId>[]>(
    () => [
      { id: 'library', label: 'Music', icon: <Glyph name="note" />, count: state.library.tracks.length },
      { id: 'now-playing', label: 'Now playing', icon: <Glyph name="play" /> },
      { id: 'queue', label: 'Up next', icon: <Glyph name="sort" />, count: Math.max(0, state.queue.length - state.queueIndex - 1) },
      { id: 'playlists', label: 'Playlists', icon: <Glyph name="folder" />, count: state.playlists.length },
      { id: 'search', label: 'Search', icon: <Glyph name="search" />, status: hubStatus.connected ? null : 'Searches this device only until a hub is paired' },
      { id: 'constellation', label: 'Constellation', icon: <Glyph name="star" /> },
      { id: 'metrics', label: 'Listening', icon: <Glyph name="history" /> },
      { id: 'equaliser', label: 'Equaliser', icon: <Glyph name="eq" />, status: state.resolvedEq.presetName },
      { id: 'settings', label: 'Settings', icon: <Glyph name="gear" /> },
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

  const onSearch = useCallback((value: string) => setQuery(value), []);

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
  const offline = entry ? offlineOf(entry.track, state.library.ephemeralTrackIds.has(entry.track.trackId)) : { offline: false, reason: 'Nothing is queued yet' };
  /*
   * With nothing queued the hero says so once. It deliberately does not repeat the library's empty
   * state headline: two identical sentences on one screen read as a rendering bug, and the hero's
   * job here is to say the transport has nothing to act on, not to re-teach the library.
   */
  const heroTitle = entry?.track.title ?? 'Nothing playing';
  const heroArtist = entry?.track.artistName ?? (state.library.tracks.length ? 'Choose something from your library' : 'Add a folder of music below to begin');

  return (
    <div className="np-app">
      <PageBar
        label="Now Playing"
        search={
          <BarSearch
            label="Search your music"
            placeholder="Search your music"
            value={query}
            onChange={onSearch}
            open={popoverOpen}
            onOpenChange={setPopoverOpen}
            onSubmit={() => setView('search')}
            onArrow={(delta) => popover.current?.move(delta)}
            onCommit={() => popover.current?.commit()}
            activeDescendant={activeOption}
            controls="np-search-list"
            results={
              <SearchPopover
                ref={popover}
                idPrefix="np-search"
                onActiveDescendant={setActiveOption}
                query={query}
                tracks={state.library.tracks}
                onAudition={(track) => store.auditionUrl(track.id)}
                onAuditionPause={() => {
                  // An audition borrows the speakers; whatever was playing gets them back after.
                  const wasPlaying = store.getSnapshot().playback.status === 'playing';
                  if (wasPlaying) store.playback.pause();
                  return wasPlaying;
                }}
                onAuditionResume={() => void store.playback.play()}
                onPlay={(track) => {
                  store.setQueue([{ id: uuidv7(), track: toTrackRef(track), context: { kind: 'search', id: null, name: 'a search' } }], 0);
                  setPopoverOpen(false);
                }}
                onClear={() => {
                  setQuery('');
                  setPopoverOpen(false);
                }}
                onSeeAll={() => {
                  setView('search');
                  setPopoverOpen(false);
                }}
              />
            }
          />
        }
        status={
          <>
            <ModeSwitch
              value={mode}
              modes={[
                { id: 'solo', label: 'Solo listening' },
                { id: 'shared', label: 'Shared listening', unavailableReason: shared.unavailableReason },
              ]}
              onChange={(next) => {
                const refused = setMode(next as 'solo' | 'shared');
                if (refused) toast.show(refused, { kind: 'info' });
                else if (next === 'shared') setView('now-playing');
              }}
              onBlocked={(reason) => toast.show(reason, { kind: 'info' })}
            />
            <BarClock />
            <ProfileButton
              label={mode === 'shared' && shared.group ? `You, listening with ${shared.group.name}` : 'You, listening on your own'}
              hue={mode === 'shared' ? 200 : 28}
              onClick={() => setView('settings')}
            />
          </>
        }
      />

      <SectionStrip items={sections} selectedId={view} onSelect={setView} label="Sections" />

      <Hero mode={mode === 'shared' ? 'shared' : 'solo'}>
        <div className="np-hero__top">
          <HeroArt src={artwork} alt="" stageRef={stageRef} />
          <div className="np-hero__meta">
            <h1 className="np-hero__title">{heroTitle}</h1>
            <p className="np-hero__artist">{heroArtist}</p>
            {entry?.track.albumName ? (
              <p className="np-hero__album">
                {entry.track.albumName}
                {entry.track.year ? ` · ${entry.track.year}` : ''}
              </p>
            ) : null}
            {entry ? <p className="np-hero__from">Playing from {entry.context.name ?? 'your library'}</p> : null}
          </div>
        </div>

        <TrackScrubber
          positionMs={state.playback.positionMs}
          durationMs={state.playback.durationMs}
          onSeek={(ms) => store.playback.seek(ms)}
          disabled={!entry}
          live={following}
          disabledReason={following ? 'This is a shared broadcast: everyone hears the same position, so it cannot be dragged from here.' : entry ? undefined : 'Nothing is queued yet'}
        />

        <KeyTransport
          disabledReason={entry ? undefined : 'Nothing is queued yet'}
          volume={<LevelSlider value={state.playback.volume} muted={state.playback.muted} onChange={(value) => store.playback.setVolume(value)} onToggleMute={() => store.playback.setMuted(!state.playback.muted)} />}
        >
          <span className="np-keys__aux">
            {/*
              * The reference's leftmost transport key: an arrow that becomes a check. It reports
              * whether this song can play with the network off, and says why when the answer is no —
              * a key that morphs on press without anything behind it would be a lie in a row of
              * controls that all do something.
              */}
            <KeyButton
              aux
              label={offline.reason}
              pressed={offline.offline}
              disabled={!entry}
              onClick={() => toast.show(offline.reason, { kind: 'info' })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                {offline.offline ? <path d="M9.9 15.4 6.4 11.9l1.9-1.9 1.6 1.6 5.8-5.8 1.9 1.9z" /> : <path d="M10.8 3h2.4v7.7h4.1L12 17.1 6.7 10.7h4.1z" />}
                <path d="M4.6 19h14.8v2.1H4.6z" />
              </svg>
            </KeyButton>
            <KeyButton
              aux
              label={liked ? 'Remove from favourites' : 'Add to favourites'}
              pressed={liked}
              disabled={!currentTrack}
              onClick={() => {
                if (currentTrack) void store.toggleLike(currentTrack.id);
              }}
            >
              <Glyph name={liked ? 'star-filled' : 'star'} />
            </KeyButton>
            <KeyButton aux label="Shuffle" pressed={state.shuffle} onClick={() => void store.setShuffle(!state.shuffle)}>
              <Glyph name="shuffle" />
            </KeyButton>
          </span>

          <KeyButton glyph="previous" label="Previous track" disabled={!entry || (state.queueIndex <= 0 && state.playback.positionMs <= 3000)} onClick={() => void store.previous()} />
          <KeyButton primary glyph={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} pressed={playing} disabled={!entry} onClick={() => void store.playback.toggle()} />
          <KeyButton glyph="next" label="Next track" disabled={!entry || (state.queueIndex >= state.queue.length - 1 && state.repeat !== 'all')} onClick={() => void store.next('user')} />

          <span className="np-keys__aux">
            <KeyButton
              aux
              glyph={state.repeat === 'one' ? 'repeat-one' : 'repeat'}
              label={state.repeat === 'one' ? 'Repeat: one' : state.repeat === 'all' ? 'Repeat: all' : 'Repeat: off'}
              pressed={state.repeat !== 'off'}
              onClick={() => void store.setRepeat(state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off')}
            />
            <KeyButton aux label="Add to a playlist" disabled={!entry} onClick={() => setAddToPlaylistOpen(true)}>
              <Glyph name="add" />
            </KeyButton>
            <KeyButton
              aux
              label="Share this song"
              disabled={!entry}
              onClick={() => {
                if (!hubStatus.connected) {
                  toast.show('Sharing needs a paired hub: the link has to be served by something other people can reach.', { kind: 'info' });
                  return;
                }
                setShareOpen(true);
              }}
            >
              <Glyph name="share" />
            </KeyButton>
          </span>
        </KeyTransport>

        <JewelStage stageRef={stageRef} album={stageAlbum} playing={playing} />

        {mode === 'shared' ? <SharedStrip /> : null}
      </Hero>

      <main className="aqua-content np-body" tabIndex={-1}>
        <div className="np-body__inner">
          <NoticeBar />
          <Suspense fallback={<LoadingState title="Opening…" inline />}>{body}</Suspense>
        </div>
        <div className="np-foot">
          <output aria-live="polite">{statusLine(state, hubStatus.connected, hubStatus.hubName, mode, shared.group?.name ?? null)}</output>
          <span className="np-foot__right">
            {state.playback.dspUnavailableReason ? <StatusDot kind="warning" label="EQ unavailable" /> : <StatusDot kind="ok" label={state.resolvedEq.presetName} />}
            <span>{`${formatTime(state.playback.positionMs)} / ${formatTime(state.playback.durationMs)}`}</span>
          </span>
        </div>
      </main>

      <AddToPlaylistSheet open={addToPlaylistOpen} onClose={() => setAddToPlaylistOpen(false)} tracks={entry ? [entry.track] : []} />
      <ShareSheet open={shareOpen} onClose={() => setShareOpen(false)} kind="track" track={entry?.track ?? null} />
    </div>
  );
}

function statusLine(state: ReturnType<typeof useAppState>, hubConnected: boolean, hubName: string | null, mode: 'solo' | 'shared', groupName: string | null): string {
  const parts: string[] = [];
  parts.push(`${state.library.tracks.length} track${state.library.tracks.length === 1 ? '' : 's'}`);
  if (state.queue.length) parts.push(`${state.queue.length} queued`);
  if (mode === 'shared' && groupName) parts.push(`listening with ${groupName}`);
  else parts.push(hubConnected ? `connected to ${hubName ?? 'a hub'}` : 'playing from this device');
  return parts.join(' · ');
}
