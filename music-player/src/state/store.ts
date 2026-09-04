/**
 * The player's single store.
 *
 * A plain observable rather than a state library: the player has one long-lived object graph (the
 * database, the playback engine, the queue) and a handful of screens, so a reducer framework would
 * add indirection without removing any decisions. `useSyncExternalStore` connects React to it.
 *
 * Two rules hold throughout:
 *
 * - **Listening events are append-only.** Nothing here edits or deletes one. A "skip" is a new
 *   event, not a modified "started" (docs/PRIVACY.md), which is what makes the history honest and
 *   the metrics reproducible.
 * - **Capability, not assumption.** Anything the player cannot do carries a reason string that the
 *   UI shows. There is no silent failure path.
 */
import { ALL_BUILTIN_PRESETS, computeListeningMetrics, FLAT_PRESET, isMeaningfulListen, resolveEq, uuidv7 } from '@now-playing/domain';
import type { EqBinding, EqPreset, ListeningEvent, ListeningEventType, Playlist, PlaylistItem, ResolvedEq, RetuneConfig, Track, TrackRef } from '@now-playing/contracts';
import { clearEverything, getSetting, openPlayerDb, putSetting, storageReport, type PlayerDatabase, type StoredRoot } from '../lib/db.js';
import { indexPickedFiles, resolveFile, scanRoot, supportsDirectoryHandles, type ScanProgress, type ScanResult } from '../lib/library.js';
import type { PlaybackEngine, PlaybackState } from '../lib/playback.js';

export type RepeatMode = 'off' | 'one' | 'all';

export interface QueueEntry {
  id: string;
  track: TrackRef;
  /** Where this entry came from, for the "playing from" line and for context-aware recommendations. */
  context: { kind: 'library' | 'playlist' | 'album' | 'artist' | 'search' | 'recommendation' | 'hub'; id: string | null; name: string | null };
}

export interface LibraryState {
  tracks: Track[];
  roots: StoredRoot[];
  /**
   * Tracks whose file cannot be reopened after a reload.
   *
   * A file chosen with the one-shot picker gets the same locator as one scanned from a folder — the
   * difference lives on its `files` record, not on the track. The list's offline key would
   * otherwise tell someone a picked file is "already on this device", which is exactly the sort of
   * claim this app does not make. So the flag is carried here, where the UI can read it.
   */
  ephemeralTrackIds: ReadonlySet<string>;
  scanning: ScanProgress | null;
  lastScan: ScanResult | null;
  /** Set when the browser cannot keep folders connected, so the UI can say so once. */
  directoryHandleReason: string | null;
}

export interface AppState {
  ready: boolean;
  library: LibraryState;
  playlists: Playlist[];
  playlistItems: PlaylistItem[];
  presets: EqPreset[];
  bindings: EqBinding[];
  events: ListeningEvent[];
  queue: QueueEntry[];
  queueIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
  playback: PlaybackState;
  resolvedEq: ResolvedEq;
  retune: RetuneConfig;
  retuneNote: string | null;
  /** Errors worth showing once, newest first. */
  notices: Array<{ id: string; kind: 'info' | 'warning' | 'error'; message: string }>;
  storage: Awaited<ReturnType<typeof storageReport>> | null;
  sessionId: string;
  deviceId: string;
}

const DEFAULT_RETUNE: RetuneConfig = { referenceHz: 440, pitchOffsetCents: 0, mode: 'off', updatedAt: new Date(0).toISOString() };

export type Listener = () => void;

export class PlayerStore {
  private state: AppState;
  private readonly listeners = new Set<Listener>();
  private db: PlayerDatabase | null = null;
  private playbackStarted: { trackId: string; at: number; secondsPlayed: number } | null = null;
  private scanAbort: AbortController | null = null;

  constructor(readonly playback: PlaybackEngine) {
    this.state = {
      ready: false,
      library: { tracks: [], roots: [], ephemeralTrackIds: new Set(), scanning: null, lastScan: null, directoryHandleReason: null },
      playlists: [],
      playlistItems: [],
      presets: [...ALL_BUILTIN_PRESETS],
      bindings: [],
      events: [],
      queue: [],
      queueIndex: -1,
      shuffle: false,
      repeat: 'off',
      playback: playback.getState(),
      resolvedEq: { presetId: FLAT_PRESET.id, presetName: 'Flat', source: 'flat', explanation: 'Flat — no preset selected' },
      retune: DEFAULT_RETUNE,
      retuneNote: null,
      sessionId: uuidv7(),
      deviceId: '00000000-0000-7000-8000-000000000000',
      notices: [],
      storage: null,
    };
    playback.subscribe((playbackState) => {
      this.patch({ playback: playbackState });
      this.trackProgress(playbackState);
    });
  }

  /* ------------------------------------------------------------ subscription */

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  private patch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  notice(kind: 'info' | 'warning' | 'error', message: string): void {
    this.patch({ notices: [{ id: uuidv7(), kind, message }, ...this.state.notices].slice(0, 20) });
  }

  dismissNotice(id: string): void {
    this.patch({ notices: this.state.notices.filter((n) => n.id !== id) });
  }

  /* -------------------------------------------------------------- lifecycle */

  async init(db?: PlayerDatabase): Promise<void> {
    this.db = db ?? (await openPlayerDb());
    const [tracks, roots, files, playlists, playlistItems, storedPresets, bindings, events] = await Promise.all([
      this.db.getAll('tracks'),
      this.db.getAll('roots'),
      this.db.getAll('files'),
      this.db.getAll('playlists'),
      this.db.getAll('playlistItems'),
      this.db.getAll('eqPresets'),
      this.db.getAll('eqBindings'),
      this.db.getAll('events'),
    ]);

    const deviceId = await getSetting(this.db, 'deviceId', '');
    const resolvedDeviceId = deviceId || uuidv7();
    if (!deviceId) await putSetting(this.db, 'deviceId', resolvedDeviceId);

    const retune = await getSetting<RetuneConfig>(this.db, 'retune', DEFAULT_RETUNE);
    const shuffle = await getSetting(this.db, 'shuffle', false);
    const repeat = await getSetting<RepeatMode>(this.db, 'repeat', 'off');

    this.patch({
      ready: true,
      library: {
        tracks: tracks.filter((t) => !t.deletedAt),
        roots,
        ephemeralTrackIds: ephemeralIds(files),
        scanning: null,
        lastScan: null,
        directoryHandleReason: supportsDirectoryHandles() ? null : 'This browser cannot keep a folder connected between visits, so files added here are available only until you reload. Chrome, Edge and Opera can keep folders connected.',
      },
      playlists: playlists.filter((p) => !p.deletedAt),
      playlistItems: playlistItems.filter((i) => !i.deletedAt),
      // Built-ins are always present and are not stored, so they cannot be deleted by accident.
      presets: [...ALL_BUILTIN_PRESETS, ...storedPresets.filter((p) => !p.deletedAt)],
      bindings: bindings.filter((b) => !b.deletedAt),
      events,
      deviceId: resolvedDeviceId,
      retune,
      shuffle,
      repeat,
      storage: await storageReport(this.db),
    });
    this.recomputeEq();
  }

  private require(): PlayerDatabase {
    if (!this.db) throw new Error('The player database is not open yet');
    return this.db;
  }

  /* ----------------------------------------------------------------- library */

  async addDirectory(): Promise<void> {
    if (!supportsDirectoryHandles()) {
      this.notice('warning', this.state.library.directoryHandleReason ?? 'This browser cannot connect a folder.');
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await (window as unknown as { showDirectoryPicker: (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'now-playing-music', mode: 'read', startIn: 'music' });
    } catch (err) {
      // AbortError means the person closed the picker: not a failure, nothing to report.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      this.notice('error', `That folder could not be opened: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const db = this.require();
    const root: StoredRoot = { id: uuidv7(), kind: 'directory', displayName: handle.name, handle, trackCount: 0, addedAt: new Date().toISOString(), lastScanAt: null, lastScanError: null };
    await db.put('roots', root);
    this.patch({ library: { ...this.state.library, roots: [...this.state.library.roots, root] } });
    await this.rescan(root.id);
  }

  async addFiles(files: readonly File[]): Promise<void> {
    const db = this.require();
    const root: StoredRoot = { id: uuidv7(), kind: 'files', displayName: `${files.length} file${files.length === 1 ? '' : 's'}`, handle: null, trackCount: files.length, addedAt: new Date().toISOString(), lastScanAt: new Date().toISOString(), lastScanError: null };
    await db.put('roots', root);
    const result = await indexPickedFiles(db, root.id, files, { onProgress: (progress) => this.patch({ library: { ...this.state.library, scanning: progress } }) });
    await this.reloadLibrary();
    this.patch({ library: { ...this.state.library, scanning: null, lastScan: result } });
    if (result.unreadable.length) this.notice('warning', `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read.`);
  }

  async rescan(rootId: string): Promise<void> {
    const db = this.require();
    const root = this.state.library.roots.find((r) => r.id === rootId);
    if (!root) return;
    this.scanAbort?.abort();
    this.scanAbort = new AbortController();
    try {
      const result = await scanRoot(db, root, { signal: this.scanAbort.signal, onProgress: (progress) => this.patch({ library: { ...this.state.library, scanning: progress } }) });
      await this.reloadLibrary();
      this.patch({ library: { ...this.state.library, scanning: null, lastScan: result } });
      if (result.unreadable.length) this.notice('warning', `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} in ${root.displayName} could not be read.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await db.put('roots', { ...root, lastScanError: reason });
      this.patch({ library: { ...this.state.library, scanning: null } });
      this.notice('error', reason);
    }
  }

  async removeRoot(rootId: string): Promise<void> {
    const db = this.require();
    const refs = await db.getAllFromIndex('files', 'by-root', rootId);
    const now = new Date().toISOString();
    const tx = db.transaction(['tracks', 'files', 'roots'], 'readwrite');
    for (const ref of refs) {
      const track = await tx.objectStore('tracks').get(ref.trackId);
      // Tombstone rather than delete, so the removal propagates to a hub or companion.
      if (track) await tx.objectStore('tracks').put({ ...track, deletedAt: now, updatedAt: now });
      await tx.objectStore('files').delete(ref.trackId);
    }
    await tx.objectStore('roots').delete(rootId);
    await tx.done;
    await this.reloadLibrary();
  }

  private async reloadLibrary(): Promise<void> {
    const db = this.require();
    const [tracks, roots, files] = await Promise.all([db.getAll('tracks'), db.getAll('roots'), db.getAll('files')]);
    this.patch({
      library: { ...this.state.library, tracks: tracks.filter((t) => !t.deletedAt), roots, ephemeralTrackIds: ephemeralIds(files) },
      storage: await storageReport(db),
    });
  }

  /**
   * A blob URL for a short audition of a track, or the reason there is not one.
   *
   * The caller owns the URL and must revoke it. Kept separate from `loadCurrent` on purpose: an
   * audition is not playback — it does not touch the queue, it does not file a listening event, and
   * it must not leave the player pointing at a song nobody asked to hear.
   */
  async auditionUrl(trackId: string): Promise<{ url: string; reason: null } | { url: null; reason: string }> {
    const resolved = await resolveFile(this.require(), trackId);
    if (!resolved.file) return { url: null, reason: resolved.reason };
    return { url: URL.createObjectURL(resolved.file), reason: null };
  }

  async artworkUrl(artworkId: string | null): Promise<string | null> {
    if (!artworkId) return null;
    const row = await this.require().get('artwork', artworkId);
    return row ? URL.createObjectURL(row.blob) : null;
  }

  /* ------------------------------------------------------------------- queue */

  setQueue(entries: QueueEntry[], startIndex = 0): void {
    this.patch({ queue: entries, queueIndex: entries.length ? Math.min(Math.max(0, startIndex), entries.length - 1) : -1 });
    void this.loadCurrent(true);
  }

  enqueue(entries: QueueEntry[], position: 'end' | 'next' = 'end'): void {
    const queue = [...this.state.queue];
    if (position === 'next' && this.state.queueIndex >= 0) queue.splice(this.state.queueIndex + 1, 0, ...entries);
    else queue.push(...entries);
    this.patch({ queue });
    // `library` and `hub` are the player's own context names; the event schema calls both 'manual'.
    for (const entry of entries) this.recordEvent('queued', entry.track, { contextKind: entry.context.kind === 'library' || entry.context.kind === 'hub' ? 'manual' : entry.context.kind, contextId: entry.context.id });
    if (this.state.queueIndex === -1) {
      this.patch({ queueIndex: 0 });
      void this.loadCurrent(true);
    }
  }

  removeFromQueue(entryId: string): void {
    const index = this.state.queue.findIndex((e) => e.id === entryId);
    if (index === -1) return;
    const queue = this.state.queue.filter((e) => e.id !== entryId);
    const queueIndex = index < this.state.queueIndex ? this.state.queueIndex - 1 : Math.min(this.state.queueIndex, queue.length - 1);
    this.patch({ queue, queueIndex });
  }

  moveInQueue(from: number, to: number): void {
    const queue = [...this.state.queue];
    const [moved] = queue.splice(from, 1);
    if (!moved) return;
    queue.splice(Math.max(0, Math.min(to, queue.length)), 0, moved);
    const current = this.state.queue[this.state.queueIndex];
    this.patch({ queue, queueIndex: current ? queue.findIndex((e) => e.id === current.id) : this.state.queueIndex });
  }

  clearQueue(): void {
    this.playback.stop();
    this.patch({ queue: [], queueIndex: -1 });
  }

  current(): QueueEntry | null {
    return this.state.queue[this.state.queueIndex] ?? null;
  }

  async loadCurrent(autoplay: boolean): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    this.recomputeEq();
    const resolved = await resolveFile(this.require(), entry.track.trackId);
    if (resolved.file) {
      await this.playback.load({ track: entry.track, file: resolved.file });
    } else {
      const hubLocator = entry.track.locators.find((l) => l.kind === 'hub-blob');
      if (hubLocator) {
        await this.playback.load({ track: entry.track, url: `/api/v1/library/stream/${entry.track.trackId}`, processable: true });
      } else {
        this.notice('warning', resolved.reason);
        this.patch({ playback: { ...this.state.playback, status: 'error', error: resolved.reason } });
        return;
      }
    }
    if (autoplay) {
      const result = await this.playback.play();
      if (!result.ok && result.reason) this.notice('info', result.reason);
    }
  }

  async next(reason: 'user' | 'ended' = 'user'): Promise<void> {
    const entry = this.current();
    if (entry) this.recordSkipOrCompletion(entry, reason);
    if (this.state.repeat === 'one' && reason === 'ended') {
      this.playback.seek(0);
      await this.playback.play();
      return;
    }
    const nextIndex = this.state.shuffle ? this.pickShuffleIndex() : this.state.queueIndex + 1;
    if (nextIndex >= this.state.queue.length) {
      if (this.state.repeat === 'all' && this.state.queue.length) {
        this.patch({ queueIndex: 0 });
        await this.loadCurrent(true);
      } else {
        this.playback.stop();
        this.patch({ queueIndex: this.state.queue.length ? this.state.queue.length - 1 : -1 });
      }
      return;
    }
    this.patch({ queueIndex: nextIndex });
    await this.loadCurrent(true);
  }

  async previous(): Promise<void> {
    // Below three seconds, "previous" means the previous track; after that it restarts this one,
    // which is what every music player has done since the CD player.
    if (this.state.playback.positionMs > 3000) {
      this.playback.seek(0);
      return;
    }
    if (this.state.queueIndex <= 0) {
      this.playback.seek(0);
      return;
    }
    this.patch({ queueIndex: this.state.queueIndex - 1 });
    await this.loadCurrent(true);
  }

  async jumpTo(index: number): Promise<void> {
    if (index < 0 || index >= this.state.queue.length) return;
    const entry = this.current();
    if (entry) this.recordSkipOrCompletion(entry, 'user');
    this.patch({ queueIndex: index });
    await this.loadCurrent(true);
  }

  private pickShuffleIndex(): number {
    if (this.state.queue.length <= 1) return this.state.queueIndex + 1;
    let index = this.state.queueIndex;
    // Never repeat the current track immediately; anything else is fair.
    while (index === this.state.queueIndex) index = Math.floor(Math.random() * this.state.queue.length);
    return index;
  }

  async setShuffle(shuffle: boolean): Promise<void> {
    this.patch({ shuffle });
    await putSetting(this.require(), 'shuffle', shuffle);
  }

  async setRepeat(repeat: RepeatMode): Promise<void> {
    this.patch({ repeat });
    await putSetting(this.require(), 'repeat', repeat);
  }

  /* ------------------------------------------------------------------ events */

  private trackProgress(playbackState: PlaybackState): void {
    if (playbackState.status === 'playing' && playbackState.trackId) {
      if (!this.playbackStarted || this.playbackStarted.trackId !== playbackState.trackId) {
        this.playbackStarted = { trackId: playbackState.trackId, at: Date.now(), secondsPlayed: 0 };
        const entry = this.current();
        if (entry) this.recordEvent('started', entry.track, { positionMs: playbackState.positionMs });
      }
    }
    if (this.playbackStarted && playbackState.trackId === this.playbackStarted.trackId) {
      this.playbackStarted.secondsPlayed = playbackState.positionMs / 1000;
      const entry = this.current();
      if (entry && !this.meaningfulRecorded.has(playbackState.trackId ?? '') && isMeaningfulListen(this.playbackStarted.secondsPlayed, entry.track.durationMs)) {
        this.meaningfulRecorded.add(playbackState.trackId ?? '');
        this.recordEvent('meaningful', entry.track, { secondsPlayed: this.playbackStarted.secondsPlayed, positionMs: playbackState.positionMs });
      }
    }
    if (playbackState.status === 'ended') void this.next('ended');
  }

  private readonly meaningfulRecorded = new Set<string>();

  private recordSkipOrCompletion(entry: QueueEntry, reason: 'user' | 'ended'): void {
    const seconds = this.state.playback.positionMs / 1000;
    const duration = entry.track.durationMs;
    const completion = duration ? Math.min(100, (this.state.playback.positionMs / duration) * 100) : null;
    const type: ListeningEventType = reason === 'ended' || (completion !== null && completion >= 90) ? 'completed' : 'skipped';
    this.recordEvent(type, entry.track, { secondsPlayed: seconds, completionPercent: completion, positionMs: this.state.playback.positionMs, reason: reason === 'user' ? 'user' : 'ended' });
    this.meaningfulRecorded.delete(entry.track.trackId);
  }

  /**
   * Append one listening event. Events are never edited or deleted here — that is what "append-only"
   * means, and it is why the metrics can be recomputed from scratch at any time.
   */
  recordEvent(type: ListeningEventType, track: TrackRef | null, extra: Partial<ListeningEvent> = {}): void {
    const event: ListeningEvent = {
      id: uuidv7(),
      schemaVersion: 1,
      type,
      occurredAt: new Date().toISOString(),
      sessionId: this.state.sessionId,
      deviceId: this.state.deviceId,
      mode: 'solo',
      groupId: null,
      trackId: track?.trackId ?? null,
      track: track
        ? {
            title: track.title,
            artistName: track.artistName,
            artistId: null,
            albumName: track.albumName,
            albumId: null,
            genre: track.genre,
            tags: [],
            year: track.year,
            durationMs: track.durationMs,
            provider: track.provider,
            popularity: null,
          }
        : null,
      positionMs: null,
      secondsPlayed: null,
      completionPercent: null,
      reason: null,
      playlistId: null,
      presetId: this.state.resolvedEq.presetId,
      recommendationId: null,
      contextKind: null,
      contextId: null,
      mood: null,
      activity: null,
      ...extra,
    };
    this.patch({ events: [...this.state.events, event] });
    void this.db?.put('events', event).catch(() => this.notice('warning', 'A listening event could not be saved; your history may be incomplete.'));
  }

  metrics(topN = 10): ReturnType<typeof computeListeningMetrics> {
    return computeListeningMetrics(this.state.events, { topN });
  }

  /* ---------------------------------------------------------------------- EQ */

  private recomputeEq(): void {
    const entry = this.current();
    const playlistId = entry?.context.kind === 'playlist' ? entry.context.id : null;
    const resolved = resolveEq(this.state.bindings, { playlistId, trackId: entry?.track.trackId ?? null }, this.state.presets, { playlistName: entry?.context.name ?? null, trackTitle: entry?.track.title ?? null });
    this.patch({ resolvedEq: resolved });
    const preset = this.state.presets.find((p) => p.id === resolved.presetId) ?? FLAT_PRESET;
    this.playback.applyPreset(preset);
  }

  async savePreset(preset: EqPreset): Promise<void> {
    const db = this.require();
    await db.put('eqPresets', preset);
    const presets = [...this.state.presets.filter((p) => p.id !== preset.id), preset];
    this.patch({ presets });
    this.recomputeEq();
  }

  async deletePreset(presetId: string): Promise<void> {
    if (ALL_BUILTIN_PRESETS.some((p) => p.id === presetId)) {
      this.notice('info', 'Built-in presets cannot be deleted. Duplicate one to make your own.');
      return;
    }
    const db = this.require();
    const preset = this.state.presets.find((p) => p.id === presetId);
    if (preset) await db.put('eqPresets', { ...preset, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this.patch({ presets: this.state.presets.filter((p) => p.id !== presetId), bindings: this.state.bindings.filter((b) => b.presetId !== presetId) });
    this.recomputeEq();
  }

  async bindPreset(scope: EqBinding['scope'], presetId: string, target: { playlistId?: string | null; trackId?: string | null } = {}): Promise<void> {
    const db = this.require();
    const now = new Date().toISOString();
    const existing = this.state.bindings.find((b) => b.scope === scope && (b.playlistId ?? null) === (target.playlistId ?? null) && (b.trackId ?? null) === (target.trackId ?? null));
    const binding: EqBinding = {
      id: existing?.id ?? uuidv7(),
      schemaVersion: 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      scope,
      playlistId: target.playlistId ?? null,
      trackId: target.trackId ?? null,
      presetId,
    };
    await db.put('eqBindings', binding);
    this.patch({ bindings: [...this.state.bindings.filter((b) => b.id !== binding.id), binding] });
    this.recomputeEq();
  }

  async unbindPreset(bindingId: string): Promise<void> {
    const db = this.require();
    const binding = this.state.bindings.find((b) => b.id === bindingId);
    if (binding) await db.put('eqBindings', { ...binding, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this.patch({ bindings: this.state.bindings.filter((b) => b.id !== bindingId) });
    this.recomputeEq();
  }

  setBypass(bypassed: boolean): void {
    this.playback.setBypass(bypassed);
  }

  /* ------------------------------------------------------------------ retune */

  async setRetune(config: RetuneConfig): Promise<void> {
    const state = await this.playback.setRetune(config);
    await putSetting(this.require(), 'retune', config);
    // The engine reports what it actually did; the UI must not claim tempo was preserved when the
    // fallback changed playback rate instead.
    const note =
      state === null
        ? 'Retuning needs the audio engine, which starts after the first play.'
        : state.applied === 'none' && config.mode !== 'off'
          ? (state.workletError ?? 'Retuning is not available for this source.')
          : state.applied === 'playback-rate'
            ? 'Retuned by changing playback speed, so the tempo changes too. Preserve-tempo mode needs the pitch worklet.'
            : state.ratioClamped
              ? 'The requested pitch was outside the range the shifter supports, so it was limited.'
              : null;
    this.patch({ retune: config, retuneNote: note });
  }

  /* --------------------------------------------------------------- playlists */

  async createPlaylist(name: string, tracks: readonly TrackRef[] = []): Promise<Playlist> {
    const db = this.require();
    const now = new Date().toISOString();
    const playlist: Playlist = {
      id: uuidv7(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      name: name.slice(0, 120),
      description: null,
      ownerDeviceId: this.state.deviceId,
      ownerUserId: null,
      kind: 'user',
      eqPresetId: null,
      importedFrom: null,
      artworkId: null,
      tasteProfileId: null,
      mood: null,
      activity: null,
    };
    await db.put('playlists', playlist);
    this.patch({ playlists: [...this.state.playlists, playlist] });
    if (tracks.length) await this.addToPlaylist(playlist.id, tracks);
    return playlist;
  }

  async addToPlaylist(playlistId: string, tracks: readonly TrackRef[]): Promise<void> {
    const db = this.require();
    const now = new Date().toISOString();
    const existing = this.state.playlistItems.filter((i) => i.playlistId === playlistId);
    let position = existing.length;
    const items: PlaylistItem[] = tracks.map((track) => ({
      id: uuidv7(),
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      playlistId,
      position: position++,
      track,
      eqOverridePresetId: null,
      addedByDeviceId: this.state.deviceId,
      note: null,
    }));
    const tx = db.transaction('playlistItems', 'readwrite');
    for (const item of items) await tx.store.put(item);
    await tx.done;
    this.patch({ playlistItems: [...this.state.playlistItems, ...items] });
    for (const track of tracks) this.recordEvent('playlist-added', track, { playlistId });
  }

  async removeFromPlaylist(itemId: string): Promise<void> {
    const db = this.require();
    const item = this.state.playlistItems.find((i) => i.id === itemId);
    if (!item) return;
    await db.put('playlistItems', { ...item, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    this.patch({ playlistItems: this.state.playlistItems.filter((i) => i.id !== itemId) });
    this.recordEvent('playlist-removed', item.track, { playlistId: item.playlistId });
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    const db = this.require();
    const now = new Date().toISOString();
    const playlist = this.state.playlists.find((p) => p.id === playlistId);
    if (playlist) await db.put('playlists', { ...playlist, deletedAt: now, updatedAt: now });
    this.patch({ playlists: this.state.playlists.filter((p) => p.id !== playlistId), playlistItems: this.state.playlistItems.filter((i) => i.playlistId !== playlistId) });
  }

  async renamePlaylist(playlistId: string, name: string): Promise<void> {
    const db = this.require();
    const playlist = this.state.playlists.find((p) => p.id === playlistId);
    if (!playlist) return;
    const updated = { ...playlist, name: name.slice(0, 120), updatedAt: new Date().toISOString() };
    await db.put('playlists', updated);
    this.patch({ playlists: this.state.playlists.map((p) => (p.id === playlistId ? updated : p)) });
  }

  /* -------------------------------------------------------------------- like */

  async toggleLike(trackId: string): Promise<void> {
    const db = this.require();
    const track = this.state.library.tracks.find((t) => t.id === trackId);
    if (!track) return;
    const updated = { ...track, liked: !track.liked, updatedAt: new Date().toISOString() };
    await db.put('tracks', updated);
    this.patch({ library: { ...this.state.library, tracks: this.state.library.tracks.map((t) => (t.id === trackId ? updated : t)) } });
    this.recordEvent(updated.liked ? 'liked' : 'unliked', toTrackRef(updated));
  }

  /* ------------------------------------------------------------------ privacy */

  async deleteAllData(): Promise<void> {
    const db = this.require();
    await clearEverything(db);
    this.playback.stop();
    this.patch({
      library: { tracks: [], roots: [], ephemeralTrackIds: new Set(), scanning: null, lastScan: null, directoryHandleReason: this.state.library.directoryHandleReason },
      playlists: [],
      playlistItems: [],
      presets: [...ALL_BUILTIN_PRESETS],
      bindings: [],
      events: [],
      queue: [],
      queueIndex: -1,
      storage: await storageReport(db),
    });
    this.notice('info', 'Everything stored by the player on this device has been deleted. Your music files were not touched.');
  }
}

function ephemeralIds(files: readonly { trackId: string; ephemeral?: boolean }[]): ReadonlySet<string> {
  return new Set(files.filter((file) => file.ephemeral).map((file) => file.trackId));
}

export function toTrackRef(track: Track): TrackRef {
  return {
    trackId: track.id,
    title: track.title,
    artistName: track.artistName,
    albumName: track.albumName,
    durationMs: track.durationMs,
    artworkId: track.artworkId,
    identity: track.identity,
    locators: track.locators,
    provider: 'local',
    genre: track.genre,
    year: track.year,
  };
}
