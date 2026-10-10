/**
 * The companion's playlist folder (DEC-041; CMP-PL-001…CMP-PL-006): `Music\Airwave Playlists` by
 * default, any folder the person picks in Settings ▸ Playlists. The files are the truth — one .m3u8
 * and one .airwave.json per playlist (`@now-playing/domain/playlist-folder`) — and this module only
 * answers the `playlists:*` channels with them.
 *
 * File access lives in the main process, beside the library's own: a song filed from search is
 * written as a path relative to the folder when a music folder in the library has the file (matched
 * by ISRC, else by artist, title and length), and as its best source URL when it does not. Paths
 * stay in this process pair (docs/PRIVACY.md); nothing here is sent to a hub.
 *
 * Electron is not imported: the folder picker, Open Folder and the save dialog are the caller's, so
 * this can be exercised against a real store and a real folder in tests.
 */
import { watch, type FSWatcher } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { DomainError } from '@now-playing/domain';
import { PlaylistFolderStore, isInsideRoot } from '@now-playing/domain/playlist-folder';
import type { CatalogTrack, FolderPlaylistAdd, FolderPlaylistAddResult, FolderPlaylistCreate, FolderPlaylistList, FolderPlaylistPage, FolderPlaylistSummary, PlaylistFolderInfo } from '@now-playing/contracts';
import type { CompanionStore } from './store.js';

/** Who made or added it, as the files record it on this PC. */
export const COMPANION_ACTOR = 'companion';

export interface CompanionPlaylistsOptions {
  store: CompanionStore;
  /** The chosen folder, or null for the default. */
  chosenDir: () => string | null;
  /** `%USERPROFILE%\Music\Airwave Playlists`. */
  defaultDir: string;
  /** The folder changed on disk (a list edited elsewhere): the window reads it again. */
  onChange?: () => void;
  now?: () => number;
}

interface Answer<T> {
  result: T | null;
  reason: string | null;
}

function why(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Windows didn’t let the companion write to the playlist folder. Choose another folder in Settings ▸ Playlists.';
  if (code === 'ENOSPC') return 'The drive the playlist folder is on is full.';
  return err instanceof Error ? err.message : String(err);
}

async function answer<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { result: await work(), reason: null };
  } catch (err) {
    return { result: null, reason: why(err) };
  }
}

function norm(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export class CompanionPlaylists {
  readonly store: PlaylistFolderStore;
  private watcher: FSWatcher | null = null;
  private watchedDir: string | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CompanionPlaylistsOptions) {
    this.store = new PlaylistFolderStore({
      dir: () => this.dir(),
      allowedRoots: () => options.store.folderPaths('music'),
      locate: (track) => this.locate(track),
      trackIdForPath: (path) => this.trackIdForPath(path),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  dir(): string {
    return resolve(this.options.chosenDir() ?? this.options.defaultDir);
  }

  /** A music folder's file for a song from search: by ISRC, else the same artist and title within 3 s. */
  locate(track: CatalogTrack): string | null {
    const { items } = this.options.store.searchTracks({ query: `${track.title}`.slice(0, 120), limit: 50, offset: 0 });
    const words = `${norm(track.artist)}|${norm(track.title)}`;
    const hit =
      (track.isrc ? items.find((t) => t.identity?.isrc?.toUpperCase() === track.isrc!.toUpperCase()) : undefined) ??
      items.find((t) => `${norm(t.artistName)}|${norm(t.title)}` === words && (t.durationMs === null || track.durationMs === null || Math.abs((t.durationMs ?? 0) - track.durationMs) <= 3_000));
    if (!hit) return null;
    const record = this.options.store.findTrack(hit.id);
    const folder = record ? this.options.store.findFolder(record.folderId) : undefined;
    if (!record || !folder || folder.kind !== 'music') return null;
    const root = resolve(folder.path);
    const file = resolve(root, ...record.relativePath.split('/'));
    return isInsideRoot(root, file) ? file : null;
  }

  private trackIdForPath(path: string): string | null {
    for (const folder of this.options.store.listFolders(() => true)) {
      if (folder.kind !== 'music' || !isInsideRoot(folder.path, path)) continue;
      const rel = relative(resolve(folder.path), resolve(path)).split(sep).join('/');
      const found = this.options.store.findTrackByPath(folder.id, rel);
      if (found && !found.deletedAt) return found.id;
    }
    return null;
  }

  async folder(): Promise<PlaylistFolderInfo> {
    const { scan } = await this.store.list();
    return { path: scan.dir, relativePath: null, isDefault: this.options.chosenDir() === null, available: scan.available, reason: scan.reason, playlistCount: scan.playlists.length, capped: scan.capped };
  }

  async list(probe: { catalogId?: string | undefined; isrc?: string | undefined }): Promise<FolderPlaylistList> {
    const { scan, items } = await this.store.list(probe);
    // After the scan, which makes the folder when it is missing: a folder that is not there cannot be watched.
    this.watchFolder();
    return { folder: { path: scan.dir, relativePath: null, isDefault: this.options.chosenDir() === null, available: scan.available, reason: scan.reason, playlistCount: items.length, capped: scan.capped }, items };
  }

  page(id: string, offset: number, limit: number): Promise<Answer<FolderPlaylistPage>> {
    return answer(() => this.store.page(id, offset, limit));
  }

  create(input: FolderPlaylistCreate): Promise<Answer<FolderPlaylistSummary>> {
    return answer(() => this.store.create(input, COMPANION_ACTOR));
  }

  update(id: string, patch: { name?: string | undefined; description?: string | null | undefined }): Promise<Answer<FolderPlaylistSummary>> {
    return answer(() => this.store.update(id, patch));
  }

  async delete(id: string): Promise<{ ok: boolean; reason: string | null }> {
    const done = await answer(() => this.store.delete(id));
    return { ok: done.reason === null, reason: done.reason };
  }

  add(id: string, input: FolderPlaylistAdd): Promise<Answer<FolderPlaylistAddResult>> {
    return answer(() => this.store.add(id, input.tracks, { position: input.position, allowDuplicates: input.allowDuplicates }, COMPANION_ACTOR));
  }

  remove(id: string, entryIds: readonly string[]): Promise<Answer<FolderPlaylistSummary>> {
    return answer(() => this.store.removeEntries(id, entryIds));
  }

  move(id: string, entryId: string, to: number): Promise<Answer<FolderPlaylistSummary>> {
    return answer(() => this.store.move(id, entryId, to));
  }

  /** The .m3u8, for the save dialog's suggested name, and written where the person chose. */
  exportName(id: string): Promise<Answer<{ fileName: string; text: string }>> {
    return answer(() => this.store.exportText(id));
  }

  async exportTo(id: string, target: string): Promise<{ path: string | null; reason: string | null }> {
    const done = await answer(async () => {
      const { text } = await this.store.exportText(id);
      await writeFile(target, text, 'utf8');
      return target;
    });
    return { path: done.result, reason: done.reason };
  }

  /** Move every playlist into a newly chosen folder (before the preference changes). */
  async moveTo(target: string): Promise<{ moved: number; failed: string[]; reason: string | null }> {
    const done = await answer(() => this.store.moveAllTo(target));
    return { moved: done.result?.moved ?? 0, failed: done.result?.failed ?? [], reason: done.reason };
  }

  /** Watch the folder while the app runs, so a list changed in another player shows up without a click. */
  watchFolder(): void {
    const dir = this.dir();
    if (this.watchedDir === dir) return;
    this.stop();
    try {
      this.watcher = watch(dir, { persistent: false }, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.options.onChange?.(), 400);
      });
      this.watcher.on('error', () => this.stop());
      this.watchedDir = dir;
    } catch {
      this.watcher = null;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watchedDir = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }
}
