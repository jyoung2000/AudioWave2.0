/**
 * Watching the library folders, so "keeps watching your folders" is something the app does.
 *
 * `chokidar` was a dependency imported nowhere, the `watchFolders` preference was written and never
 * read, and the `folders.watch` column was set and never consulted. A user who dropped an album into
 * a watched folder saw nothing until they pressed Scan.
 *
 * What it deliberately does *not* do is scan on every event. A file copy fires dozens of events, an
 * album copy thousands, and a scan is expensive. So each root collects its events into one debounced
 * wake-up and then runs the same incremental scan the Scan button runs — which already skips files
 * whose size and mtime are unchanged, so the common case is cheap.
 */
import { watch, type FSWatcher } from 'chokidar';

/** How long a root must be quiet before it is scanned. Long enough to cover a multi-file copy. */
export const WATCH_DEBOUNCE_MS = 2000;

export interface WatchedFolder {
  id: string;
  path: string;
  /** The per-folder switch. A folder can be in the library without being watched. */
  watch: boolean;
}

export interface FolderWatcherOptions {
  /** Run the incremental scan for one root. Rejections are reported, never thrown at the watcher. */
  onChanged: (folderId: string) => void | Promise<unknown>;
  onError?: (folderId: string, error: Error) => void;
  debounceMs?: number;
  /** Injected in tests so a fake watcher can stand in for the real filesystem. */
  createWatcher?: (path: string) => FSWatcher;
}

interface Entry {
  path: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

function defaultWatcher(path: string): FSWatcher {
  return watch(path, {
    // The initial contents are not a change: the library already knows them, and announcing them
    // would make every start of the app a full rescan of every folder.
    ignoreInitial: true,
    // Music files arrive by copy, and a copy is visible long before it is complete. Waiting for the
    // size to settle is the difference between indexing an album and indexing half of one.
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    // `depth` is deliberately not set: omitting it is chokidar's unlimited, and people keep music
    // in Artist/Album/Disc trees where any limit would silently stop watching part-way down.
    ignorePermissionErrors: true,
  });
}

/**
 * Keeps one watcher per enabled root, matching whatever `sync` was last told.
 *
 * Idempotent: calling `sync` with the same folders changes nothing, so it is safe to call whenever
 * the folder list or the preference might have moved.
 */
export class FolderWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly debounceMs: number;
  private readonly create: (path: string) => FSWatcher;

  constructor(private readonly options: FolderWatcherOptions) {
    this.debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
    this.create = options.createWatcher ?? defaultWatcher;
  }

  /** The folder ids currently being watched. */
  get watching(): string[] {
    return [...this.entries.keys()].sort();
  }

  /**
   * @param enabled - the `watchFolders` preference. Off stops everything, without forgetting which
   * folders would be watched if it were turned back on.
   */
  sync(folders: readonly WatchedFolder[], enabled: boolean): void {
    const wanted = new Map(enabled ? folders.filter((f) => f.watch).map((f) => [f.id, f.path] as const) : []);

    // Gone, switched off, or moved to a different path: stop the old watcher first.
    for (const [id, entry] of [...this.entries]) {
      if (wanted.get(id) !== entry.path) void this.stop(id);
    }
    for (const [id, path] of wanted) {
      if (this.entries.has(id)) continue;
      let watcher: FSWatcher;
      try {
        watcher = this.create(path);
      } catch (error) {
        // An unreadable or disconnected root must not stop the others from being watched.
        this.options.onError?.(id, error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      const entry: Entry = { path, watcher, timer: null };
      this.entries.set(id, entry);
      watcher.on('all', () => this.touch(id));
      watcher.on('error', (error: unknown) => this.options.onError?.(id, error instanceof Error ? error : new Error(String(error))));
    }
  }

  /** Stop watching and forget everything; the app is closing. */
  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  private async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.watcher.close().catch(() => undefined);
  }

  /** One more event on this root: push the scan back until the root has been quiet. */
  private touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // `sync` may have dropped this root while the timer was pending.
      if (!this.entries.has(id)) return;
      void Promise.resolve(this.options.onChanged(id)).catch((error: unknown) => {
        this.options.onError?.(id, error instanceof Error ? error : new Error(String(error)));
      });
    }, this.debounceMs);
    // A pending rescan must not hold the process open at quit.
    entry.timer.unref?.();
  }
}
