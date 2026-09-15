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
import { forgetPickedFiles, indexPickedFiles, resolveFile, scanRoot, supportsDirectoryHandles, type ScanProgress, type ScanResult } from '../lib/library.js';
import type { PlaybackEngine, PlaybackEvent, PlaybackState } from '../lib/playback.js';
import { DEFAULT_CROSSFADE, crossfadeMsBetween, normalizeCrossfade, type CrossfadeSettings } from '../lib/crossfade.js';
import { copiesSupported, removeCopy, requestPersistentStorage } from '../lib/copies.js';
import { defaultDestination, pickDownloadFolder, supportsDownloadFolder, type DownloadDestination } from '../lib/download-folder.js';
import { jumpInShuffle, makeShuffleOrder, nextInShuffle, previousInShuffle, remainingInShuffle, syncShuffleOrder, type ShuffleOrder } from '../lib/shuffle.js';
import type * as DiscoverModule from '../lib/discover.js';
import type { Discovery } from '../lib/discover.js';
import type * as HelperModule from '../lib/fetch-helper.js';
import type { HelperConnection, SavedHelper } from '../lib/fetch-helper.js';
import type { DownloadAuthorizationBasis, HelperToolId, OutputFormat } from '@now-playing/contracts';
import type { TasteProfile } from '@now-playing/recommendations';

/**
 * The recommender, fetched the first time something needs it.
 *
 * It is a substantial piece of code and nothing before the first note wants
 * it: a queue only runs out after a track has played, and "play similar to
 * this" is a deliberate act. Loading it eagerly put 150 KB in front of
 * everyone who opens the player, including the ones who never reach the end
 * of an album.
 */
const discoverModule = (): Promise<typeof DiscoverModule> => import('../lib/discover.js');

/**
 * The helper client, on the same terms. Almost nobody runs a helper, and the ones who do can wait
 * the few milliseconds it takes to fetch this after the page has painted.
 */
const helperModule = (): Promise<typeof HelperModule> => import('../lib/fetch-helper.js');

export type RepeatMode = 'off' | 'one' | 'all';

/** A single thing the listener can do about a notice, such as reloading into a new version. */
export interface NoticeAction {
  label: string;
  run: () => void;
}

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
  /** Keep a copy of each chosen file inside the app. On by default where folders cannot be kept. */
  keepCopies: boolean;
  /** Why copies cannot be kept here, or null when they can. */
  copiesReason: string | null;
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
  /** The shuffled pass over the queue while shuffle is on; null when it is off. */
  shuffleOrder: ShuffleOrder | null;
  /** Where a saved copy is written, and whether it is filed under Artist/Album. */
  downloads: { destination: DownloadDestination; organise: boolean };
  /** Keep playing past the end of the queue, with music the recommender picks. */
  autoplay: boolean;
  /** What discover added last, and why, so the interface can say so. */
  lastDiscovery: { reason: string; count: number } | null;
  repeat: RepeatMode;
  crossfade: CrossfadeSettings;
  playback: PlaybackState;
  resolvedEq: ResolvedEq;
  retune: RetuneConfig;
  retuneNote: string | null;
  /** Errors worth showing once, newest first. */
  notices: Array<{ id: string; kind: 'info' | 'warning' | 'error'; message: string; action?: NoticeAction }>;
  storage: Awaited<ReturnType<typeof storageReport>> | null;
  /**
   * Official platform artwork the listener supplied, as object URLs keyed by provider slug. Empty
   * by default: the built-in marks are ours, and nobody's logo ships in this bundle.
   */
  providerArtwork: Readonly<Record<string, string>>;
  /**
   * A local helper, if one answered just now. Null is the normal state and means the interface
   * offers nothing that would need one — the player never remembers a helper into existence.
   */
  helper: HelperConnection | null;
  /** Where a helper was last saved by hand, for the case where the player is hosted elsewhere. */
  savedHelper: SavedHelper | null;
  /**
   * False until the first probe has finished. It matters: a `helper: null` that has not been asked
   * yet and one that has been asked and answered are different facts, and the interface must not
   * report the second while it means the first.
   */
  helperProbed: boolean;
  /** The fetch in flight, if any, so the interface can show what the tool is doing. */
  helperJob: { url: string; stage: string; percent: number | null; message: string | null } | null;
  sessionId: string;
  deviceId: string;
}

const DEFAULT_RETUNE: RetuneConfig = { referenceHz: 440, pitchOffsetCents: 0, mode: 'off', updatedAt: new Date(0).toISOString() };

/** Platform artwork shares the artwork store; the prefix keeps it apart from album covers. */
const ARTWORK_PREFIX = 'platform:';

/** A URL reduced to the bit worth showing someone. Never throws: it is only ever used in a sentence. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'that link';
  }
}
const artworkKey = (provider: string): string => `${ARTWORK_PREFIX}${provider}`;

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
      library: { tracks: [], roots: [], ephemeralTrackIds: new Set(), scanning: null, lastScan: null, directoryHandleReason: null, keepCopies: false, copiesReason: null },
      playlists: [],
      playlistItems: [],
      presets: [...ALL_BUILTIN_PRESETS],
      bindings: [],
      events: [],
      queue: [],
      queueIndex: -1,
      shuffle: false,
      shuffleOrder: null,
      downloads: { destination: { kind: 'browser' }, organise: false },
      autoplay: false,
      lastDiscovery: null,
      repeat: 'off',
      crossfade: { ...DEFAULT_CROSSFADE },
      playback: playback.getState(),
      resolvedEq: { presetId: FLAT_PRESET.id, presetName: 'Flat', source: 'flat', explanation: 'Flat — no preset selected' },
      retune: DEFAULT_RETUNE,
      retuneNote: null,
      sessionId: uuidv7(),
      deviceId: '00000000-0000-7000-8000-000000000000',
      notices: [],
      storage: null,
      providerArtwork: {},
      helper: null,
      savedHelper: null,
      helperProbed: false,
      helperJob: null,
    };
    playback.subscribe((playbackState) => {
      this.patch({ playback: playbackState });
      this.trackProgress(playbackState);
    });
    playback.onEvent((event) => this.onPlaybackEvent(event));
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

  notice(kind: 'info' | 'warning' | 'error', message: string, action?: NoticeAction): void {
    this.patch({ notices: [{ id: uuidv7(), kind, message, ...(action ? { action } : {}) }, ...this.state.notices].slice(0, 20) });
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
    const crossfade = normalizeCrossfade(await getSetting<unknown>(this.db, 'playback.crossfade', DEFAULT_CROSSFADE));
    const autoplay = await getSetting(this.db, 'playback.autoplay', false);

    /*
     * The download folder. The handle is stored as the browser gave it to us
     * and comes back usable; whether we are still *allowed* to write to it is
     * a separate question, asked at the moment of saving because only a click
     * can answer it.
     */
    const downloadMode = await getSetting<'folder' | 'ask' | 'browser' | null>(this.db, 'downloads.mode', null);
    const downloadFolder = await getSetting<FileSystemDirectoryHandle | null>(this.db, 'downloads.folder', null);
    const organise = await getSetting(this.db, 'downloads.organise', false);
    const destination: DownloadDestination =
      downloadMode === 'folder' && downloadFolder
        ? { kind: 'folder', handle: downloadFolder, name: downloadFolder.name }
        : downloadMode === 'ask' || downloadMode === 'browser'
          ? { kind: downloadMode }
          : defaultDestination();
    // Copies are the phone's answer to folders: where a folder cannot be kept connected, keeping
    // the files themselves is what makes the library survive a reload, so that is the default there.
    const copies = await copiesSupported();
    const keepCopies = copies.ok ? await getSetting(this.db, 'library.keepCopies', !supportsDirectoryHandles()) : false;

    const providerArtwork = await this.loadProviderArtwork();
    const savedHelper = await getSetting<SavedHelper | null>(this.db, 'helper.saved', null);

    this.patch({
      ready: true,
      library: {
        tracks: tracks.filter((t) => !t.deletedAt),
        roots,
        ephemeralTrackIds: ephemeralIds(files),
        scanning: null,
        lastScan: null,
        directoryHandleReason: supportsDirectoryHandles()
          ? null
          : copies.ok
            ? 'This browser cannot keep a folder connected between visits, so choose files instead: the player keeps a copy of each inside the app, and they play offline and after a reload.'
            : 'This browser cannot keep a folder connected between visits, so files added here are available only until you reload. Chrome, Edge and Opera can keep folders connected.',
        keepCopies,
        copiesReason: copies.ok ? null : copies.reason,
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
      crossfade,
      // The queue is empty on a cold start, so the pass is built when one is set.
      shuffleOrder: shuffle ? { ids: [], pos: -1 } : null,
      downloads: { destination, organise },
      providerArtwork,
      savedHelper,
      autoplay,
      storage: await storageReport(this.db),
    });
    this.recomputeEq();
    this.playback.setCrossfade(crossfade.enabled ? crossfade.seconds : 0);
    // Not awaited: whether a helper is running has nothing to do with whether the player can start,
    // and the answer arrives in a render or two either way.
    void this.refreshHelper();
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

  async setKeepCopies(keepCopies: boolean): Promise<void> {
    this.patch({ library: { ...this.state.library, keepCopies } });
    await putSetting(this.require(), 'library.keepCopies', keepCopies);
  }

  async addFiles(files: readonly File[]): Promise<void> {
    const db = this.require();
    const keepCopies = this.state.library.keepCopies && this.state.library.copiesReason === null;
    // The first music someone keeps is the moment to ask the browser to keep it too.
    if (keepCopies) void requestPersistentStorage();
    const root: StoredRoot = { id: uuidv7(), kind: 'files', displayName: `${files.length} file${files.length === 1 ? '' : 's'}`, handle: null, copied: keepCopies, trackCount: files.length, addedAt: new Date().toISOString(), lastScanAt: new Date().toISOString(), lastScanError: null };
    await db.put('roots', root);
    const result = await indexPickedFiles(db, root.id, files, { keepCopies, onProgress: (progress) => this.patch({ library: { ...this.state.library, scanning: progress } }) });
    await this.reloadLibrary();
    this.patch({ library: { ...this.state.library, scanning: null, lastScan: result } });
    if (result.unreadable.length) this.notice('warning', `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read.`);
    if (result.notCopied.length) {
      const first = result.notCopied[0]!;
      this.notice('warning', `${result.notCopied.length === 1 ? `A copy of ${first.path}` : `Copies of ${result.notCopied.length} files`} could not be kept (${first.reason}). ${result.notCopied.length === 1 ? 'It plays' : 'They play'} until you reload.`);
    }
  }

  /**
   * Import a .zip — a Bandcamp purchase, a Google Takeout of your YouTube Music uploads, a set of
   * downloadable SoundCloud tracks. Everything audio inside becomes a library track; everything
   * else is left in the archive. See `lib/zip.ts`.
   */
  async importArchives(archives: readonly File[]): Promise<void> {
    const { looksLikeZip, readZip, zipSupported } = await import('../lib/zip.js');
    if (!zipSupported()) {
      this.notice('warning', 'This browser cannot unpack a .zip on its own. Unzip it first, then add the folder or choose the files.');
      return;
    }
    const zips = archives.filter(looksLikeZip);
    const notZips = archives.filter((file) => !looksLikeZip(file));
    if (notZips.length) {
      // Someone picked a mix. Take the audio straight through rather than refusing the lot.
      await this.addFiles(notZips);
    }
    if (!zips.length) return;

    const extracted: File[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const zip of zips) {
      this.patch({ library: { ...this.state.library, scanning: { found: 0, indexed: 0, skipped: 0, currentPath: `Unpacking ${zip.name}` } } });
      try {
        const result = await readZip(zip, (done, total) => this.patch({ library: { ...this.state.library, scanning: { found: total, indexed: done, skipped: 0, currentPath: `Unpacking ${zip.name}` } } }));
        extracted.push(...result.files);
        skipped.push(...result.skipped.filter((entry) => entry.reason !== 'not an audio file'));
      } catch (error) {
        this.patch({ library: { ...this.state.library, scanning: null } });
        this.notice('error', `${zip.name} could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.patch({ library: { ...this.state.library, scanning: null } });
    if (!extracted.length) {
      if (zips.length) this.notice('warning', `No audio was found inside ${zips.length === 1 ? zips[0]!.name : `${zips.length} archives`}.`);
      return;
    }
    await this.addFiles(extracted);
    if (skipped.length) {
      const first = skipped[0]!;
      this.notice('warning', `${skipped.length} track${skipped.length === 1 ? '' : 's'} in the archive could not be read — ${first.name}: ${first.reason}.`);
    }
  }

  /**
   * Put a platform's official artwork in place of the built-in mark, or clear it. The file is kept
   * in this device's own database and never leaves it; nothing is fetched and nothing is shipped.
   */
  async setPlatformArtwork(provider: string, file: File | null): Promise<void> {
    const db = this.require();
    const id = artworkKey(provider);
    const previous = this.state.providerArtwork[provider];
    if (!file) {
      await db.delete('artwork', id);
      if (previous) URL.revokeObjectURL(previous);
      const { [provider]: _removed, ...rest } = this.state.providerArtwork;
      this.patch({ providerArtwork: rest });
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.notice('warning', `${file.name} is not an image.`);
      return;
    }
    await db.put('artwork', { id, blob: file, mime: file.type });
    if (previous) URL.revokeObjectURL(previous);
    this.patch({ providerArtwork: { ...this.state.providerArtwork, [provider]: URL.createObjectURL(file) } });
  }

  /**
   * Ask whether a local helper is there, right now.
   *
   * Called at startup and whenever the Platforms panel is opened, because a helper can be started
   * or stopped while the page is sitting there. Nothing about the answer is cached beyond the
   * current state: the moment it stops answering, every control it enabled goes away.
   */
  async refreshHelper(): Promise<void> {
    const { detectHelper } = await helperModule();
    const helper = await detectHelper(this.state.savedHelper);
    this.patch({ helper, helperProbed: true });
  }

  /** Remember a helper that is not serving this page, for a player hosted somewhere else. */
  async saveHelper(saved: SavedHelper | null): Promise<void> {
    this.patch({ savedHelper: saved });
    await putSetting(this.require(), 'helper.saved', saved);
    await this.refreshHelper();
    if (saved && !this.state.helper) {
      this.notice('warning', `Nothing answered at ${saved.origin}. Check the helper is running, that it was started with --allow-origin ${window.location.origin}, and that the token matches.`);
    }
  }

  /** Ask the helper to fetch a tool for itself. Only yt-dlp; the helper refuses the rest and says why. */
  async installHelperTool(tool: HelperToolId): Promise<void> {
    const helper = this.state.helper;
    if (!helper) return this.notice('warning', 'No helper is running, so there is nothing to install into.');
    const { installTool } = await helperModule();
    try {
      const result = await installTool(helper, tool);
      if (!result.installed) return this.notice('warning', result.reason ?? `${tool} was not installed.`);
      await this.refreshHelper();
      this.notice('info', `${tool} ${result.version ?? ''} is ready.`.replace('  ', ' '));
    } catch (error) {
      this.notice('error', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Fetch a link through the helper and put what comes back in the library.
   *
   * The rights basis is a required argument rather than a default, because it is the whole point:
   * the helper refuses without one, and the person choosing it is the person making the claim.
   */
  async fetchLink(url: string, options: { basis: DownloadAuthorizationBasis; format: OutputFormat; tool?: 'auto' | 'yt-dlp' | 'spotdl' }): Promise<void> {
    const helper = this.state.helper;
    if (!helper) return this.notice('warning', 'No helper is running. Start one and it will appear in Settings → Platforms.');
    const { runFetch } = await helperModule();
    this.patch({ helperJob: { url, stage: 'preflight', percent: null, message: null } });
    try {
      const { files } = await runFetch(helper, { url, tool: options.tool ?? 'auto', format: options.format, authorization: { basis: options.basis, acknowledged: true } }, (job) =>
        this.patch({ helperJob: { url, stage: job.stage, percent: job.percent, message: job.message } }),
      );
      this.patch({ helperJob: null });
      await this.addFiles(files);
      this.notice('info', `${files.length} ${files.length === 1 ? 'track' : 'tracks'} added from ${hostOf(url)}.`);
    } catch (error) {
      this.patch({ helperJob: null });
      this.notice('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async loadProviderArtwork(): Promise<Record<string, string>> {
    const db = this.require();
    const stored = await db.getAll('artwork');
    const artwork: Record<string, string> = {};
    for (const item of stored) {
      if (!item.id.startsWith(ARTWORK_PREFIX)) continue;
      artwork[item.id.slice(ARTWORK_PREFIX.length)] = URL.createObjectURL(item.blob);
    }
    return artwork;
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
    // The copies were the player's own; removing the root is the request to let them go.
    await Promise.all(refs.filter((ref) => ref.copyId).map((ref) => removeCopy(ref.copyId!)));
    // Any picked files this root held are unreachable now; nothing should keep them alive.
    forgetPickedFiles(refs.map((ref) => ref.trackId));
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

  /**
   * Where the person left the jewel case and the disc pointing.
   *
   * A pose is a preference, not library data: it belongs beside the volume and the repeat mode, so
   * it lives in the settings store rather than in the 3D module's own corner of storage.
   */
  async loadStagePose(): Promise<{ caseY: number; caseX: number; discY: number; discX: number } | null> {
    if (!this.db) return null;
    return getSetting<{ caseY: number; caseX: number; discY: number; discX: number } | null>(this.db, 'stage.pose', null);
  }

  saveStagePose(pose: { caseY: number; caseX: number; discY: number; discX: number }): void {
    if (this.db) void putSetting(this.db, 'stage.pose', pose);
  }

  /**
   * The bytes behind a track, when this device can reach them. Null with no
   * excuse: the caller shows the reason from the locators instead.
   */
  async fileFor(trackId: string): Promise<File | null> {
    if (!this.db) return null;
    const resolved = await resolveFile(this.db, trackId);
    return resolved.file;
  }

  async artworkUrl(artworkId: string | null): Promise<string | null> {
    if (!artworkId) return null;
    const row = await this.require().get('artwork', artworkId);
    return row ? URL.createObjectURL(row.blob) : null;
  }

  /* ------------------------------------------------------------------- queue */

  setQueue(entries: QueueEntry[], startIndex = 0): void {
    const from = this.current()?.track ?? null;
    const queueIndex = entries.length ? Math.min(Math.max(0, startIndex), entries.length - 1) : -1;
    // A new queue is a new pass: the track being started leads it.
    const order = this.state.shuffle ? makeShuffleOrder(entries.map((e) => e.id), entries[queueIndex]?.id ?? null) : null;
    this.patch({ queue: entries, queueIndex, shuffleOrder: order });
    void this.loadCurrent(true, from);
  }

  enqueue(entries: QueueEntry[], position: 'end' | 'next' = 'end'): void {
    const queue = [...this.state.queue];
    if (position === 'next' && this.state.queueIndex >= 0) queue.splice(this.state.queueIndex + 1, 0, ...entries);
    else queue.push(...entries);
    this.patch({ queue, shuffleOrder: this.resyncShuffle(queue) });
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
    this.patch({ queue, queueIndex, shuffleOrder: this.resyncShuffle(queue) });
  }

  moveInQueue(from: number, to: number): void {
    const queue = [...this.state.queue];
    const [moved] = queue.splice(from, 1);
    if (!moved) return;
    queue.splice(Math.max(0, Math.min(to, queue.length)), 0, moved);
    const current = this.state.queue[this.state.queueIndex];
    // Reordering the queue is about the queue's own order; the pass is unaffected.
    this.patch({ queue, queueIndex: current ? queue.findIndex((e) => e.id === current.id) : this.state.queueIndex });
  }

  clearQueue(): void {
    this.playback.stop();
    this.patch({ queue: [], queueIndex: -1, shuffleOrder: this.state.shuffle ? { ids: [], pos: -1 } : null });
  }

  current(): QueueEntry | null {
    return this.state.queue[this.state.queueIndex] ?? null;
  }

  /**
   * Load the entry at the queue index. `from` is the track that was playing before the index
   * moved, which is what decides whether the handover is a crossfade or a cut.
   */
  async loadCurrent(autoplay: boolean, from: TrackRef | null = null): Promise<void> {
    const entry = this.current();
    if (!entry) return;
    this.recomputeEq();
    const crossfadeMs = crossfadeMsBetween(this.state.crossfade, from, entry.track);
    const resolved = await resolveFile(this.require(), entry.track.trackId);
    if (resolved.file) {
      await this.playback.load({ track: entry.track, file: resolved.file, crossfadeMs });
    } else {
      const hubLocator = entry.track.locators.find((l) => l.kind === 'hub-blob');
      if (hubLocator) {
        await this.playback.load({ track: entry.track, url: `/api/v1/library/stream/${entry.track.trackId}`, processable: true, crossfadeMs });
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

  /**
   * Move on. `user` is a skip, `ended` the natural end of the track, and `crossfade` the point
   * one crossfade before that end: the next track starts now, over this one, and this one's
   * completion is recorded when its deck actually finishes.
   */
  async next(reason: 'user' | 'ended' | 'crossfade' = 'user'): Promise<void> {
    const entry = this.current();
    if (reason === 'crossfade') {
      const step = this.state.repeat === 'one' ? { index: this.state.queueIndex, order: this.state.shuffleOrder } : this.advance();
      // Nothing to fade into: let the track end on its own.
      if (step === null || !entry) return;
      this.outgoing = entry;
      this.patch({ queueIndex: step.index, ...(step.order ? { shuffleOrder: step.order } : {}) });
      await this.loadCurrent(true, entry.track);
      return;
    }
    if (entry) this.recordSkipOrCompletion(entry, reason);
    if (this.state.repeat === 'one' && reason === 'ended') {
      this.playback.seek(0);
      await this.playback.play();
      return;
    }
    const step = this.advance();
    if (step === null) {
      // The queue is finished. Discover mode, when it is on, keeps the music
      // going rather than letting the room go quiet.
      if (await this.extendWithDiscoveries(entry?.track ?? null)) return;
      this.playback.stop();
      this.patch({ queueIndex: this.state.queue.length ? this.state.queue.length - 1 : -1 });
      return;
    }
    this.patch({ queueIndex: step.index, ...(step.order ? { shuffleOrder: step.order } : {}) });
    await this.loadCurrent(true, entry?.track ?? null);
  }

  /**
   * What plays after this, or null when the queue is finished.
   *
   * Under shuffle this walks the pass rather than picking at random, and
   * returns the advanced pass with it — the caller commits both together, so
   * a step that is abandoned (nothing to fade into) does not consume a track.
   */
  private advance(): { index: number; order: ShuffleOrder | null } | null {
    const repeatAll = this.state.repeat === 'all' && this.state.queue.length > 0;
    if (this.state.shuffle && this.state.shuffleOrder) {
      const step = nextInShuffle(this.state.shuffleOrder, repeatAll);
      if (!step) return null;
      const index = this.state.queue.findIndex((e) => e.id === step.id);
      return index === -1 ? null : { index, order: step.order };
    }
    const next = this.state.queueIndex + 1;
    if (next < this.state.queue.length) return { index: next, order: null };
    return repeatAll ? { index: 0, order: null } : null;
  }

  async previous(): Promise<void> {
    // Below three seconds, "previous" means the previous track; after that it restarts this one,
    // which is what every music player has done since the CD player.
    if (this.state.playback.positionMs > 3000) {
      this.playback.seek(0);
      return;
    }
    const from = this.current()?.track ?? null;
    if (this.state.shuffle && this.state.shuffleOrder) {
      // Back through what was actually heard, not back through the queue.
      const step = previousInShuffle(this.state.shuffleOrder);
      const index = step ? this.state.queue.findIndex((e) => e.id === step.id) : -1;
      if (!step || index === -1) {
        this.playback.seek(0);
        return;
      }
      this.patch({ queueIndex: index, shuffleOrder: step.order });
      await this.loadCurrent(true, from);
      return;
    }
    if (this.state.queueIndex <= 0) {
      this.playback.seek(0);
      return;
    }
    this.patch({ queueIndex: this.state.queueIndex - 1 });
    await this.loadCurrent(true, from);
  }

  async jumpTo(index: number): Promise<void> {
    if (index < 0 || index >= this.state.queue.length) return;
    const entry = this.current();
    if (entry) this.recordSkipOrCompletion(entry, 'user');
    const picked = this.state.queue[index];
    const order = this.state.shuffle && this.state.shuffleOrder && picked ? jumpInShuffle(this.state.shuffleOrder, picked.id) : this.state.shuffleOrder;
    this.patch({ queueIndex: index, shuffleOrder: order });
    await this.loadCurrent(true, entry?.track ?? null);
  }


  /**
   * Turning shuffle on deals a fresh pass over the queue and leaves the song
   * that is playing exactly where it is — an iPod never cut the track you
   * were on to start shuffling. Turning it off drops the pass and the queue
   * carries on in its own order from wherever you are.
   */
  async setShuffle(shuffle: boolean): Promise<void> {
    const order = shuffle ? makeShuffleOrder(this.state.queue.map((e) => e.id), this.current()?.id ?? null) : null;
    this.patch({ shuffle, shuffleOrder: order });
    await putSetting(this.require(), 'shuffle', shuffle);
  }

  /** Keep the pass in step after the queue is added to, reordered or trimmed. */
  private resyncShuffle(queue: readonly QueueEntry[]): ShuffleOrder | null {
    if (!this.state.shuffle) return null;
    const ids = queue.map((e) => e.id);
    const order = this.state.shuffleOrder;
    return order ? syncShuffleOrder(order, ids) : makeShuffleOrder(ids, this.current()?.id ?? null);
  }

  /** The entries still to play, in the order they will actually play in. */
  upNext(): QueueEntry[] {
    const byId = new Map(this.state.queue.map((e) => [e.id, e]));
    if (this.state.shuffle && this.state.shuffleOrder) {
      return remainingInShuffle(this.state.shuffleOrder)
        .map((id) => byId.get(id))
        .filter((e): e is QueueEntry => e !== undefined);
    }
    return this.state.queue.slice(this.state.queueIndex + 1);
  }

  async setRepeat(repeat: RepeatMode): Promise<void> {
    this.patch({ repeat });
    await putSetting(this.require(), 'repeat', repeat);
  }

  /* --------------------------------------------------------------- discover */

  /**
   * The taste profile, kept between calls.
   *
   * `applyEvents` skips events it has already folded in, so handing it the
   * whole history each time costs only what is new — but building the profile
   * from scratch on every track change would not, which is why it is cached.
   */
  private tasteProfile: TasteProfile | null = null;

  private async profile(): Promise<TasteProfile> {
    const { profileFrom } = await discoverModule();
    this.tasteProfile = profileFrom(this.state.deviceId, this.state.events, this.tasteProfile);
    return this.tasteProfile;
  }

  /* -------------------------------------------------------------- downloads */

  /**
   * Point the player at a folder. Returns the reason it could not, or null.
   *
   * The handle is kept, not the path: the player has no way to learn where
   * the folder is on disk and nothing it could log if it did.
   */
  async chooseDownloadFolder(): Promise<string | null> {
    if (!supportsDownloadFolder()) {
      return 'This browser will not hand a folder to a web app, so downloads go wherever it puts them.';
    }
    let handle: FileSystemDirectoryHandle | null;
    try {
      handle = await pickDownloadFolder();
    } catch (err) {
      return `That folder could not be opened: ${err instanceof Error ? err.message : String(err)}`;
    }
    // The picker was closed: nothing chosen, nothing to report.
    if (!handle) return null;
    const db = this.require();
    await putSetting(db, 'downloads.folder', handle);
    await putSetting(db, 'downloads.mode', 'folder');
    this.patch({ downloads: { ...this.state.downloads, destination: { kind: 'folder', handle, name: handle.name } } });
    return null;
  }

  /** Go back to being asked each time, or to the browser's own downloads folder. */
  async setDownloadMode(mode: 'ask' | 'browser'): Promise<void> {
    const db = this.require();
    await putSetting(db, 'downloads.mode', mode);
    await putSetting(db, 'downloads.folder', null);
    this.patch({ downloads: { ...this.state.downloads, destination: { kind: mode } } });
  }

  async setOrganiseDownloads(organise: boolean): Promise<void> {
    this.patch({ downloads: { ...this.state.downloads, organise } });
    await putSetting(this.require(), 'downloads.organise', organise);
  }

  async setAutoplay(autoplay: boolean): Promise<void> {
    this.patch({ autoplay, ...(autoplay ? {} : { lastDiscovery: null }) });
    await putSetting(this.require(), 'playback.autoplay', autoplay);
  }

  /** Queue entries for tracks the recommender picked, tagged as recommendations. */
  private discoveryEntries(picks: readonly Discovery[], explain: (pick: Discovery) => string): QueueEntry[] {
    return picks.map((pick) => ({
      id: uuidv7(),
      track: toTrackRef(pick.track),
      context: { kind: 'recommendation' as const, id: pick.track.id, name: explain(pick) },
    }));
  }

  /**
   * The queue has run out. With autoplay on, put more music behind it.
   *
   * Returns true when it found something and playback continues. The seed is
   * the track that just finished, so what follows sounds like where the
   * listener had got to rather than like their library average.
   */
  private async extendWithDiscoveries(from: TrackRef | null): Promise<boolean> {
    if (!this.state.autoplay || this.state.library.tracks.length === 0) return false;
    const seed = from ? (this.state.library.tracks.find((t) => t.id === from.trackId) ?? null) : null;
    const queued = new Set(this.state.queue.map((e) => e.track.trackId));
    let result;
    try {
      const { discover, AUTOPLAY_BATCH } = await discoverModule();
      result = discover({ userId: this.state.deviceId, profile: await this.profile(), library: this.state.library.tracks, seed, exclude: queued, limit: AUTOPLAY_BATCH });
    } catch (err) {
      this.notice('warning', `Discover could not pick anything: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (result.picks.length === 0) {
      if (result.shortfall) this.notice('info', `Discover found nothing to add: ${result.shortfall}`);
      return false;
    }
    const { explain } = await discoverModule();
    const entries = this.discoveryEntries(result.picks, explain);
    const queue = [...this.state.queue, ...entries];
    const first = entries[0]!;
    this.patch({
      queue,
      shuffleOrder: this.resyncShuffle(queue),
      lastDiscovery: { reason: explain(result.picks[0]!), count: entries.length },
    });
    for (const pick of result.picks) this.recordEvent('recommendation-shown', toTrackRef(pick.track), { contextKind: 'manual' });
    const index = queue.findIndex((e) => e.id === first.id);
    const order = this.state.shuffle && this.state.shuffleOrder ? jumpInShuffle(this.state.shuffleOrder, first.id) : this.state.shuffleOrder;
    this.patch({ queueIndex: index, shuffleOrder: order });
    await this.loadCurrent(true, from);
    return true;
  }

  /**
   * Play music like this track, now: its own queue, starting with the seed so
   * the listener hears where it came from.
   */
  async playSimilarTo(track: Track): Promise<{ ok: boolean; reason: string | null }> {
    if (this.state.library.tracks.length < 2) {
      return { ok: false, reason: 'There is not enough music on this device yet to find something similar.' };
    }
    const { discover, explain, SIMILAR_BATCH } = await discoverModule();
    const result = discover({ userId: this.state.deviceId, profile: await this.profile(), library: this.state.library.tracks, seed: track, limit: SIMILAR_BATCH });
    if (result.picks.length === 0) {
      return { ok: false, reason: result.shortfall ?? 'Nothing on this device came close enough to suggest.' };
    }
    const seedEntry: QueueEntry = { id: uuidv7(), track: toTrackRef(track), context: { kind: 'recommendation', id: track.id, name: `Similar to ${track.title}` } };
    this.setQueue([seedEntry, ...this.discoveryEntries(result.picks, explain)], 0);
    for (const pick of result.picks) this.recordEvent('recommendation-shown', toTrackRef(pick.track), { contextKind: 'manual' });
    this.patch({ lastDiscovery: { reason: `Similar to ${track.title}`, count: result.picks.length } });
    return { ok: true, reason: null };
  }

  async setCrossfade(patch: Partial<CrossfadeSettings>): Promise<void> {
    const crossfade = normalizeCrossfade({ ...this.state.crossfade, ...patch });
    this.patch({ crossfade });
    this.playback.setCrossfade(crossfade.enabled ? crossfade.seconds : 0);
    await putSetting(this.require(), 'playback.crossfade', crossfade);
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

  /** The entry a crossfade handed over, whose completion is still to be recorded. */
  private outgoing: QueueEntry | null = null;

  private onPlaybackEvent(event: PlaybackEvent): void {
    if (event.type === 'crossfade-due') {
      void this.next('crossfade');
      return;
    }
    if (event.type === 'outgoing-finished') {
      const entry = this.outgoing;
      if (!entry || entry.track.trackId !== event.trackId) return;
      this.outgoing = null;
      this.recordSkipOrCompletion(entry, event.ended ? 'ended' : 'user', event.positionMs);
    }
  }

  private recordSkipOrCompletion(entry: QueueEntry, reason: 'user' | 'ended', positionMs = this.state.playback.positionMs): void {
    const seconds = positionMs / 1000;
    const duration = entry.track.durationMs;
    const completion = duration ? Math.min(100, (positionMs / duration) * 100) : null;
    const type: ListeningEventType = reason === 'ended' || (completion !== null && completion >= 90) ? 'completed' : 'skipped';
    this.recordEvent(type, entry.track, { secondsPlayed: seconds, completionPercent: completion, positionMs, reason: reason === 'user' ? 'user' : 'ended' });
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
      library: { tracks: [], roots: [], ephemeralTrackIds: new Set(), scanning: null, lastScan: null, directoryHandleReason: this.state.library.directoryHandleReason, keepCopies: this.state.library.keepCopies, copiesReason: this.state.library.copiesReason },
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
