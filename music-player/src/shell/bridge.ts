/**
 * The bridge between the shell and the player's logic.
 *
 * The shell is `index.html`: the Airwave now-playing frontend, served as it was written, with its
 * data seams (`window.kv`, `window.LIBRARY`, `library:play`, `volume:change`, `window.hubPeople`…)
 * intact. This module loads first and stands behind those seams with the real thing:
 *
 * - `window.storage` → `db.ts`, so every `kv` key (prefs, library state, the hub credential, the
 *   listening history Statistics reads) lives in the same IndexedDB the logic layer uses;
 * - `window.LIBRARY` → the tracks `library.ts` indexed from folders and files on this device;
 * - `window.NP_PLAYER` → `PlaybackEngine` (two decks, the audio-core worklet, crossfade), so the
 *   transport's position is the element's, not a clock;
 * - `window.NP_THREE()` → the bundled three.js, loaded on demand (975 KB, not part of the first
 *   paint), so nothing is fetched from a CDN;
 * - the hub credential the shell pairs → `HubClient`, so `src/lib` sees the same pairing;
 * - `window.NP_AWSP` → streaming from a PC (`awsp.ts`, docs/AWSP.md §6), loaded lazily: its rows join
 *   `window.LIBRARY` with `remote: true` and play through the service worker's `/awsp/track/<id>`.
 *
 * `window.NP_READY` resolves when the store and library are loaded; the shell's boot function
 * (`window.__npStart`) is called then, so the first paint is the real library and never a placeholder.
 */
import type { DownloadAuthorizationBasis, Track, TrackRef } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import { workletAssetUrl } from 'virtual:np-worklet-url';
import { workletDataUrl } from '../lib/build-flags.js';
import { openPlayerDb, getSetting, putSetting, type PlayerDatabase, type StoredRoot } from '../lib/db.js';
import { indexPickedFiles, resolveFile, scanRoot, supportsDirectoryHandles } from '../lib/library.js';
import { PlaybackEngine, type PlaybackState } from '../lib/playback.js';
import { HubClient, type HubCredential } from '../lib/hub-client.js';
import { normalizeCrossfade, crossfadeMsBetween } from '../lib/crossfade.js';
import { toTrackRef } from '../state/store.js';
import { registerServiceWorker } from '../lib/pwa.js';
import type { RemoteSong, ShellAwsp } from './awsp.js';
import { detectBackend } from '../lib/tool-backend.js';
import { runFetch, ToolError } from '../lib/tools-core.js';
import type { SavedHelper } from '../lib/fetch-helper.js';

/**
 * The shell's surfaces, as design/coverage.json discovers them (kind `view-union`, prefix
 * `player-shell-`). A screen added to the shell is added here and to the ledger together.
 */
export type ShellSurface =
  | 'library'
  | 'now-playing'
  | 'search-popover'
  | 'row-menu'
  | 'new-playlist-sheet'
  | 'fetch-sheet'
  | 'mini-player'
  | 'radio'
  | 'live-tv'
  | 'tv'
  | 'movies'
  | 'settings-statistics'
  | 'settings-recommendations'
  | 'settings-sources'
  | 'stream-from-pc'
  | 'settings-player'
  | 'settings-equalizer'
  | 'settings-profile'
  | 'profile-viewer'
  | 'invite-page';

/** A library row as the shell draws it (see `window.LIBRARY` in the shell). */
export interface ShellSong {
  id: string;
  kind: 'music';
  title: string;
  artist: string;
  album: string;
  duration: number;
  bpm: number | null;
  platform: string;
  url: string | null;
  /** Not in the shell's own rows: says the file is on this device, so the transport can play it. */
  local: true;
}

export interface ShellPlayer {
  play(id: string): Promise<{ ok: boolean; reason: string | null }>;
  pause(): void;
  resume(): Promise<{ ok: boolean; reason: string | null }>;
  seek(seconds: number): void;
  position(): number;
  duration(): number | null;
  playing(): boolean;
  trackId(): string | null;
  onState(listener: (state: PlaybackState) => void): () => void;
  /** Why the DSP (equalizer, pitch) is unavailable, or null. */
  dspUnavailableReason(): string | null;
}

export interface ShellLibrary {
  supportsFolders(): boolean;
  addFolder(): Promise<{ added: number; reason: string | null }>;
  addFiles(files: readonly File[]): Promise<{ added: number; reason: string | null }>;
  rescan(): Promise<{ added: number; removed: number; reason: string | null }>;
  roots(): Promise<Array<{ id: string; displayName: string; trackCount: number; lastScanAt: string | null; lastScanError: string | null }>>;
  forgetRoot(id: string): Promise<void>;
  count(): number;
}

declare global {
  interface Window {
    storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> | void };
    LIBRARY?: Array<ShellSong | RemoteSong>;
    THREE?: unknown;
    NP_THREE?: () => Promise<unknown>;
    NP_PLAYER?: ShellPlayer;
    NP_LIBRARY?: ShellLibrary;
    NP_TOOLS?: ShellTools;
    NP_HUB?: { status(): unknown };
    NP_AWSP?: ShellAwsp;
    /** Resolves `NP_AWSP` once its module has loaded, or null in the single-file build (no service worker). */
    NP_AWSP_READY?: Promise<ShellAwsp | null>;
    NP_READY?: Promise<void>;
    NP_BRIDGE?: { version: number; log: string[] };
    __npStart?: () => void;
    outputVolume?: number;
  }
}

const KV_PREFIX = 'shell:';
const log: string[] = [];
function note(line: string): void {
  log.push(`${new Date().toISOString()} ${line}`);
  if (log.length > 60) log.shift();
}

/* ------------------------------------------------------------------- storage */

/**
 * The shell's `kv` speaks the artifact storage contract: `set(key, json)` with the value already a
 * JSON string, and `get(key)` answering `{ key, value }` (value the stored string) or null. The
 * string is stored as it arrives, so what the shell wrote is exactly what it reads back.
 */
/**
 * IndexedDB commits asynchronously; `localStorage`, which the shell was written against, does not.
 * A rename followed at once by a reload or a closed tab would lose the rename. So every write is
 * journalled synchronously first and the journal entry cleared once the database has it; anything
 * still in the journal at start-up (the page went away mid-write) is replayed before the shell runs.
 */
const JOURNAL = 'np.shell.pending:';

function journal(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function replayJournal(db: PlayerDatabase): Promise<number> {
  const ls = journal();
  if (!ls) return 0;
  const pending: Array<[string, string]> = [];
  for (let i = 0; i < ls.length; i++) {
    const name = ls.key(i);
    if (name?.startsWith(JOURNAL)) pending.push([name, ls.getItem(name) ?? '']);
  }
  for (const [name, json] of pending) {
    await putSetting(db, KV_PREFIX + name.slice(JOURNAL.length), json);
    ls.removeItem(name);
  }
  return pending.length;
}

function installStorage(db: PlayerDatabase, hub: HubClient): void {
  window.storage = {
    get: async (key) => {
      const pending = journal()?.getItem(JOURNAL + key);
      const value = pending ?? (await getSetting<string | null>(db, KV_PREFIX + key, null));
      return typeof value === 'string' ? { key, value } : null;
    },
    set: (key, value) => {
      const json = typeof value === 'string' ? value : JSON.stringify(value);
      // Never the hub credential: hub-client.ts keeps device secrets out of localStorage on purpose.
      const ls = key === 'player:hub' ? null : journal();
      try {
        ls?.setItem(JOURNAL + key, json);
      } catch {
        // Quota or a sandbox: the database write below still happens, just without the guard.
      }
      const write = putSetting(db, KV_PREFIX + key, json).then(() => {
        // Only clear it if nothing newer was journalled while this write was in flight.
        if (ls?.getItem(JOURNAL + key) === json) ls.removeItem(JOURNAL + key);
      });
      // The shell pairs with the hub itself; the credential it keeps is handed to HubClient so the
      // logic layer (groups, search, stream URLs) is paired too — one pairing, not two.
      if (key === 'player:hub') void write.then(() => syncHubCredential(hub, parseJson(json)));
      return write;
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function syncHubCredential(hub: HubClient, value: unknown): Promise<void> {
  const acct = value as { base?: string; credentialId?: string; secret?: string; scopes?: string[]; hubName?: string; deviceId?: string; hubId?: string; hubFingerprint?: string } | null;
  if (!acct || !acct.base || !acct.credentialId || !acct.secret) {
    await hub.forget().catch(() => undefined);
    return;
  }
  const credential: HubCredential = {
    endpoint: acct.base,
    hubId: acct.hubId ?? '',
    hubName: acct.hubName ?? 'hub',
    hubFingerprint: acct.hubFingerprint ?? '',
    deviceId: acct.deviceId ?? '',
    credentialId: acct.credentialId,
    secret: acct.secret,
    scopes: acct.scopes ?? [],
    pairedAt: new Date().toISOString(),
  };
  await hub.savePairing(credential).catch((err: unknown) => note(`hub credential not saved: ${err instanceof Error ? err.message : String(err)}`));
}

/* -------------------------------------------------------------------- library */

function rowOf(track: Track): ShellSong {
  return {
    id: track.id,
    kind: 'music',
    title: track.title,
    artist: track.artistName ?? '',
    album: track.albumName ?? '',
    duration: Math.round((track.durationMs ?? 0) / 1000),
    bpm: null,
    platform: 'This device',
    url: null,
    local: true,
  };
}

async function loadRows(db: PlayerDatabase): Promise<ShellSong[]> {
  const tracks = await db.getAll('tracks');
  return tracks.filter((t) => !t.deletedAt).map(rowOf).sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Replaces the shell's rows from this device in place — the shell holds the array by reference —
 * and tells it. Rows that came from a search or a pasted link (no `local` flag) are not this
 * device's files, so a rescan leaves them where they are.
 */
async function refreshRows(db: PlayerDatabase): Promise<void> {
  const rows = await loadRows(db);
  const target = window.LIBRARY ?? (window.LIBRARY = []);
  const links = target.filter((row) => !(row as { local?: boolean }).local);
  target.splice(0, target.length, ...rows, ...links);
  document.dispatchEvent(new CustomEvent('library:refresh', { detail: { count: rows.length } }));
}

function installLibrary(db: PlayerDatabase): ShellLibrary {
  const library: ShellLibrary = {
    supportsFolders: () => supportsDirectoryHandles(),
    async addFolder() {
      if (!supportsDirectoryHandles()) return { added: 0, reason: 'This browser cannot keep a folder. Choose files instead; they are indexed for this visit.' };
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await (window as unknown as { showDirectoryPicker: (o: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'read' });
      } catch (err) {
        return { added: 0, reason: err instanceof DOMException && err.name === 'AbortError' ? null : err instanceof Error ? err.message : String(err) };
      }
      const root: StoredRoot = { id: uuidv7(), kind: 'directory', displayName: handle.name, handle, trackCount: 0, addedAt: new Date().toISOString(), lastScanAt: null, lastScanError: null };
      await db.put('roots', root);
      const result = await scanRoot(db, root);
      await refreshRows(db);
      note(`folder ${handle.name}: ${result.added} added, ${result.updated} updated, ${result.unreadable.length} unreadable`);
      return { added: result.added, reason: result.unreadable.length ? `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read.` : null };
    },
    async addFiles(files) {
      if (!files.length) return { added: 0, reason: null };
      const root: StoredRoot = { id: uuidv7(), kind: 'files', displayName: `${files.length} file${files.length === 1 ? '' : 's'}`, handle: null, trackCount: 0, addedAt: new Date().toISOString(), lastScanAt: null, lastScanError: null };
      await db.put('roots', root);
      const result = await indexPickedFiles(db, root.id, files);
      // A folder scan keeps its root's count; picked files are indexed without one, so it is set here.
      await db.put('roots', { ...root, trackCount: result.added + result.updated, lastScanAt: new Date().toISOString() });
      await refreshRows(db);
      return { added: result.added, reason: result.unreadable.length ? `${result.unreadable.length} file${result.unreadable.length === 1 ? '' : 's'} could not be read.` : null };
    },
    async rescan() {
      let added = 0;
      let removed = 0;
      for (const root of await db.getAll('roots')) {
        if (root.kind !== 'directory' || !root.handle) continue;
        try {
          const result = await scanRoot(db, root);
          added += result.added;
          removed += result.removed;
        } catch (err) {
          return { added, removed, reason: `${root.displayName}: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      await refreshRows(db);
      return { added, removed, reason: null };
    },
    async roots() {
      return (await db.getAll('roots')).map((r) => ({ id: r.id, displayName: r.displayName, trackCount: r.trackCount, lastScanAt: r.lastScanAt, lastScanError: r.lastScanError }));
    },
    async forgetRoot(id) {
      const now = new Date().toISOString();
      const tx = db.transaction(['roots', 'files', 'tracks'], 'readwrite');
      for (const ref of await tx.objectStore('files').index('by-root').getAll(id)) {
        const track = await tx.objectStore('tracks').get(ref.trackId);
        if (track) await tx.objectStore('tracks').put({ ...track, deletedAt: now, updatedAt: now });
        await tx.objectStore('files').delete(ref.trackId);
      }
      await tx.objectStore('roots').delete(id);
      await tx.done;
      await refreshRows(db);
    },
    count: () => window.LIBRARY?.length ?? 0,
  };
  window.NP_LIBRARY = library;
  return library;
}

/* -------------------------------------------------------------------- player */

/** A row from the paired PC, when `id` is one. */
function remoteRow(id: string): RemoteSong | null {
  const row = window.LIBRARY?.find((r) => r.id === id);
  return row && 'remote' in row && row.remote ? row : null;
}

function installPlayer(db: PlayerDatabase, engine: PlaybackEngine): ShellPlayer {
  let current: TrackRef | null = null;
  /**
   * A track on the paired PC: the element's source is the service worker's `/awsp/track/<id>`, which
   * streams it over AWSP (docs/AWSP.md §6). Same-origin, so the DSP graph processes it as usual.
   */
  async function playRemote(row: RemoteSong): Promise<{ ok: boolean; reason: string | null }> {
    const awsp = await window.NP_AWSP_READY;
    if (!awsp) return { ok: false, reason: 'Streaming from a PC needs the served player; this copy has no service worker.' };
    const result = await awsp.play(row, async (ref, url) => {
      const crossfade = normalizeCrossfade(await getSetting(db, 'playback.crossfade', null));
      const crossfadeMs = current ? crossfadeMsBetween(crossfade, current, ref) : 0;
      await engine.load({ track: ref, url, processable: true, crossfadeMs });
      current = ref;
      return engine.play();
    });
    note(`play ${row.title} from the PC: ${result.ok ? 'ok' : result.reason}`);
    return result;
  }
  const player: ShellPlayer = {
    async play(id) {
      const remote = remoteRow(id);
      if (remote) return playRemote(remote);
      window.NP_AWSP?.indicate(false);
      const track = await db.get('tracks', id);
      if (!track || track.deletedAt) return { ok: false, reason: 'That track is no longer in the library.' };
      const resolved = await resolveFile(db, id);
      if (!resolved.file) return { ok: false, reason: resolved.reason };
      const crossfade = normalizeCrossfade(await getSetting(db, 'playback.crossfade', null));
      const ref = toTrackRef(track);
      const crossfadeMs = current ? crossfadeMsBetween(crossfade, current, ref) : 0;
      await engine.load({ track: ref, file: resolved.file, crossfadeMs });
      current = ref;
      const result = await engine.play();
      note(`play ${track.title}: ${result.ok ? 'ok' : result.reason}`);
      return result;
    },
    pause: () => engine.pause(),
    resume: () => engine.play(),
    seek: (seconds) => engine.seek(Math.max(0, seconds) * 1000),
    position: () => engine.getState().positionMs / 1000,
    duration: () => {
      const ms = engine.getState().durationMs;
      return ms === null ? null : ms / 1000;
    },
    playing: () => engine.getState().status === 'playing',
    trackId: () => engine.getState().trackId,
    onState: (listener) => engine.subscribe(listener),
    dspUnavailableReason: () => engine.getState().dspUnavailableReason,
  };
  // The shell's volume slider is the one volume: 0–100 there, 0–1 here.
  document.addEventListener('volume:change', (e) => {
    const level = (e as CustomEvent<{ level: number }>).detail?.level;
    if (typeof level === 'number') engine.setVolume(Math.max(0, Math.min(1, level)));
  });
  if (typeof window.outputVolume === 'number') engine.setVolume(window.outputVolume);
  window.NP_PLAYER = player;
  return player;
}

/* --------------------------------------------------------------------- tools */

export interface ShellTools {
  /** What answered — the helper serving this page, a saved helper, or the Android bridge — or null. */
  detect(): Promise<{ label: string; tools: Array<{ id: string; present: boolean; version: string | null }> } | null>;
  /**
   * Fetch a link through the helper and index what it saved. `basis` is the person's statement of
   * why they may have this file; the helper refuses without it, and so does this.
   */
  fetch(url: string, basis: DownloadAuthorizationBasis): Promise<{ added: number; trackId: string | null; reason: string | null }>;
}

function installTools(db: PlayerDatabase): ShellTools {
  const tools: ShellTools = {
    async detect() {
      const backend = await detectBackend(await getSetting<SavedHelper | null>(db, 'helper.saved', null));
      if (!backend) return null;
      return { label: backend.label, tools: backend.health.tools.map((t) => ({ id: t.id, present: t.present, version: t.version ?? null })) };
    },
    async fetch(url, basis) {
      const backend = await detectBackend(await getSetting<SavedHelper | null>(db, 'helper.saved', null));
      if (!backend) return { added: 0, trackId: null, reason: 'Fetching needs the local helper or the companion app running on this PC.' };
      try {
        const { files } = await runFetch(backend, { url, tool: 'auto', format: 'original', authorization: { basis, acknowledged: true } }, () => undefined);
        if (!files.length) return { added: 0, trackId: null, reason: 'The helper finished but saved no file.' };
        const root: StoredRoot = { id: uuidv7(), kind: 'files', displayName: files[0]!.name, handle: null, trackCount: 0, addedAt: new Date().toISOString(), lastScanAt: null, lastScanError: null };
        await db.put('roots', root);
        // Kept as a copy: a fetched file has no folder on this device to be read from again.
        const result = await indexPickedFiles(db, root.id, files, { keepCopies: true });
        await db.put('roots', { ...root, trackCount: result.added + result.updated, lastScanAt: new Date().toISOString() });
        await refreshRows(db);
        const ref = (await db.getAllFromIndex('files', 'by-root', root.id))[0];
        note(`fetched ${url}: ${result.added} added`);
        return { added: result.added, trackId: ref?.trackId ?? null, reason: null };
      } catch (err) {
        return { added: 0, trackId: null, reason: err instanceof ToolError || err instanceof Error ? err.message : String(err) };
      }
    },
  };
  window.NP_TOOLS = tools;
  return tools;
}

/* ---------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  // Statistics' 3D views ask for three.js when they open; the chunk is bundled, never fetched from a CDN.
  window.NP_THREE = async () => {
    if (!window.THREE) {
      const [three, controls] = await Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]);
      window.THREE = Object.assign({}, three, { OrbitControls: controls.OrbitControls });
    }
    return window.THREE;
  };
  const db = await openPlayerDb();
  const hub = new HubClient(db);
  await hub.load();
  const replayed = await replayJournal(db);
  if (replayed) note(`replayed ${replayed} write(s) the last visit did not finish`);
  installStorage(db, hub);
  installLibrary(db);
  const engine = new PlaybackEngine({ workletModuleUrl: workletDataUrl() ?? workletAssetUrl });
  installPlayer(db, engine);
  installTools(db);
  window.NP_HUB = { status: () => hub.getStatus() };
  window.LIBRARY = await loadRows(db);
  window.NP_BRIDGE = { version: 1, log };
  // Streaming from a PC: a lazy chunk, and never in the single-file build — a file:// page has no
  // service worker to be the bridge, and the wasm client would be megabytes inlined for nothing.
  // (The literal check, not isSingleFileBuild(), so the bundler drops the import there.)
  const singleFile = typeof __NP_SINGLE_FILE__ !== 'undefined' && __NP_SINGLE_FILE__ === true;
  window.NP_AWSP_READY = singleFile
    ? Promise.resolve(null)
    : import('./awsp.js').then((m) => (window.NP_AWSP = m.installAwsp(db, note))).catch((err: unknown) => {
        note(`streaming from a PC is unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
  // The installable, offline player: the worker precaches the shell and its chunks. It is a no-op in
  // the single-file build and over file://, where a worker cannot run (see lib/pwa.ts).
  void registerServiceWorker((update) => {
    note('a new version is ready');
    const say = (window as unknown as { say?: (text: string) => void }).say;
    say?.('A new version of Airwave is ready — reload to use it.');
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') update.reload(); }, { once: true });
  });
  note(`bridge ready: ${window.LIBRARY.length} tracks, hub ${hub.getStatus().connected ? 'paired' : 'not paired'}`);
  // Now the shell may run: everything it reads at boot is in place.
  window.__npStart?.();
}

// No top-level await: the single-file build is an IIFE, which cannot carry one. Everything that
// needs the bridge waits on this promise instead (the shell's Script D does).
window.NP_READY = boot();
