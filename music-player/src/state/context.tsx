/**
 * Wiring the store into React, and into the operating system.
 *
 * The store is created once, outside React, because it owns an `<audio>` element and an
 * AudioContext — objects that must not be recreated when a component re-renders. React subscribes
 * to it through `useSyncExternalStore`, which is what keeps the two in step without a render loop.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getSetting, openPlayerDb, putSetting } from '../lib/db.js';
import { GroupClient, type SharedState } from '../lib/group-client.js';
import { HubClient, type HubStatus } from '../lib/hub-client.js';
import { workletDataUrl } from '../lib/build-flags.js';
import { installHandlers, publishMetadata, publishPlaybackState, publishPosition } from '../lib/media-session.js';
import { PlaybackEngine } from '../lib/playback.js';
import { PlayerStore, type AppState } from './store.js';

export type ListeningMode = 'solo' | 'shared';

interface PlayerContextValue {
  store: PlayerStore;
  hub: HubClient | null;
  hubStatus: HubStatus;
  /** Null until the hub client exists; shared listening is a hub feature. */
  group: GroupClient | null;
  shared: SharedState;
  mode: ListeningMode;
  /** Returns the reason it refused, or null when the mode changed. */
  setMode: (mode: ListeningMode) => string | null;
}

const IDLE_SHARED: SharedState = { unavailableReason: 'No hub is paired.', connection: 'idle', group: null, members: [], queue: null, playback: null, rejection: null, staleSince: null };

const PlayerContext = createContext<PlayerContextValue | null>(null);

/**
 * Where the pitch-shifter worklet comes from.
 *
 * In the served build it is a separate entry and Vite resolves it to a hashed URL. In the
 * single-file build there is no second file to point at — and a page opened from `file://` could
 * not fetch one anyway — so the compiled worklet travels inside the bundle and is handed to the
 * audio thread as a `data:` URL. Either way the engine receives a URL and reports honestly if it
 * cannot load it.
 */
const WORKLET_URL = workletDataUrl() ?? new URL('../worklets/pitch-shifter.ts', import.meta.url).href;

export function PlayerProvider({ children, store: injected }: { children: ReactNode; store?: PlayerStore }) {
  const [store] = useState(() => injected ?? new PlayerStore(new PlaybackEngine({ workletModuleUrl: WORKLET_URL })));
  const [hub, setHub] = useState<HubClient | null>(null);
  const [hubStatus, setHubStatus] = useState<HubStatus>({ connected: false, endpoint: null, hubName: null, reason: 'No hub is paired.', identity: null, scopes: [] });
  const [group, setGroup] = useState<GroupClient | null>(null);
  const [shared, setShared] = useState<SharedState>(IDLE_SHARED);
  const [requestedMode, setRequestedMode] = useState<ListeningMode>('solo');
  const [started, setStarted] = useState(false);
  const dbRef = useRef<Awaited<ReturnType<typeof openPlayerDb>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = await openPlayerDb();
      if (cancelled) return;
      dbRef.current = db;
      await store.init(db);
      if (cancelled) return;
      const client = new HubClient(db);
      setHub(client);
      client.subscribe(setHubStatus);
      const groups = new GroupClient(client, () => 'This device');
      groups.subscribe(setShared);
      setGroup(groups);
      await client.load();
      groups.refreshAvailability(client.getStatus().connected, client.getStatus().reason);
      // The mode is remembered, but only honoured if it is still possible: coming back to a player
      // that was in a group, on a laptop that has since left the network, must land in solo rather
      // than in a shared session that is not there.
      const remembered = await getSetting<ListeningMode>(db, 'listening.mode', 'solo');
      if (!cancelled && remembered === 'shared') setRequestedMode('shared');
      setStarted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  // The hub goes up and down independently of anything the person does, and shared listening has to
  // follow it: a hub that drops takes the mode back to solo rather than leaving a dead switch on.
  useEffect(() => {
    if (!group) return;
    group.refreshAvailability(hubStatus.connected, hubStatus.reason);
  }, [group, hubStatus.connected, hubStatus.reason]);

  /*
   * The mode in force is *derived*, not stored twice.
   *
   * What a person asked for and what is possible are two different facts, and keeping the second in
   * its own state would mean writing it from an effect every time the hub came and went — a
   * cascading render, and a window in which the switch and the reality disagree. Deriving it means
   * a hub that drops takes the player back to solo in the same render that learns the hub dropped.
   * The request survives, so the mode comes back on its own when the hub does.
   */
  const mode: ListeningMode = requestedMode === 'shared' && !shared.unavailableReason ? 'shared' : 'solo';

  // Saying so, once, when it flips off underneath someone. The store is an external system, which
  // is exactly what an effect is for.
  const wasShared = useRef(false);
  useEffect(() => {
    if (wasShared.current && mode === 'solo' && requestedMode === 'shared' && shared.unavailableReason) {
      store.notice('info', `Shared listening stopped: ${shared.unavailableReason}`);
    }
    wasShared.current = mode === 'shared';
  }, [mode, requestedMode, shared.unavailableReason, store]);

  const setMode = useCallback(
    (next: ListeningMode): string | null => {
      if (next === 'shared') {
        const reason = shared.unavailableReason;
        if (reason) return reason;
      } else {
        group?.disconnect();
      }
      setRequestedMode(next);
      if (dbRef.current) void putSetting(dbRef.current, 'listening.mode', next);
      return null;
    },
    [group, shared.unavailableReason],
  );

  const value = useMemo(() => ({ store, hub, hubStatus, group, shared, mode, setMode }), [store, hub, hubStatus, group, shared, mode, setMode]);
  return (
    <PlayerContext.Provider value={value}>
      {children}
      {started ? <MediaSessionBridge /> : null}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayer must be used inside PlayerProvider');
  return value;
}

export function useAppState(): AppState {
  const { store } = usePlayer();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** A convenience selector that avoids re-rendering on every unrelated state change. */
export function useSelector<T>(select: (state: AppState) => T): T {
  const { store } = usePlayer();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getSnapshot()),
  );
}

/**
 * Keeps the lock screen, notification and car display in step with playback.
 *
 * Position is published on a one-second timer rather than on every `timeupdate`: browsers fire that
 * event four times a second, and a car's progress bar does not need four updates a second to look
 * right.
 */
function MediaSessionBridge() {
  const { store } = usePlayer();
  const state = useAppState();
  const artworkRef = useRef<{ id: string | null; url: string | null }>({ id: null, url: null });
  const entry = state.queue[state.queueIndex] ?? null;

  useEffect(() => {
    return installHandlers({
      play: () => void store.playback.play(),
      pause: () => store.playback.pause(),
      stop: () => store.playback.stop(),
      previous: () => store.previous(),
      next: () => store.next('user'),
      seekTo: (positionMs) => store.playback.seek(positionMs),
      seekBy: (offsetSeconds) => store.playback.seek(store.getSnapshot().playback.positionMs + offsetSeconds * 1000),
    });
  }, [store]);

  // Artwork is a blob URL owned here; the previous one is revoked so a long session does not leak.
  useEffect(() => {
    const artworkId = entry?.track.artworkId ?? null;
    if (artworkRef.current.id === artworkId) return;
    let cancelled = false;
    void (async () => {
      const url = await store.artworkUrl(artworkId);
      if (cancelled) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (artworkRef.current.url) URL.revokeObjectURL(artworkRef.current.url);
      artworkRef.current = { id: artworkId, url };
      publishMetadata(entry?.track ?? null, url);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry?.track.artworkId, entry?.track.trackId, store, entry]);

  useEffect(() => {
    publishPlaybackState(state.playback.status === 'playing' ? 'playing' : state.playback.status === 'idle' ? 'none' : 'paused');
  }, [state.playback.status]);

  useEffect(() => {
    if (state.playback.status !== 'playing') return;
    const publish = (): void => publishPosition(store.getSnapshot().playback.positionMs, store.getSnapshot().playback.durationMs);
    publish();
    const timer = setInterval(publish, 1000);
    return () => clearInterval(timer);
  }, [state.playback.status, store]);

  return null;
}

/** Format milliseconds as m:ss, the way a transport display does. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const useCallbackRef = useCallback;
