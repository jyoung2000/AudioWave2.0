/**
 * The hub's playlist folder (DEC-041; UX-PL-001…UX-PL-008): `<data>/playlists` by default, or any
 * folder under `<data>/playlists` or `<data>/library` the admin names in Music ▸ Playlists.
 *
 * The files are the truth (`@now-playing/domain/playlist-folder`); the hub keeps no index of them in
 * its database, only the folder's path in its settings. A song filed from search is written as a path
 * relative to the folder when the hub's library has the file (matched by ISRC, else by artist, title
 * and length), and as its best source URL when it does not.
 *
 * Who may do what: the admin, everything. A device with `playlists:use` reads every list, makes new
 * ones and files songs into any — filing is additive, and the hub is the household's shared shelf —
 * but it renames, reorders and deletes only lists it made, and removes only songs it added or songs
 * in a list it made. A player cannot empty someone else's playlist.
 */
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CatalogTrack, FolderPlaylistSummary, PlaylistFolderInfo } from '@now-playing/contracts';
import { DomainError, isSafeRelativePath } from '@now-playing/domain';
import { PlaylistFolderStore, isInsideRoot, type LoadedPlaylist, type SongProbe } from '@now-playing/domain/playlist-folder';
import type { Principal } from '../auth/principal.js';
import type { HubContext } from '../context.js';

export const PLAYLIST_FOLDER_SETTING = 'playlists.folder';
export const DEFAULT_PLAYLIST_FOLDER = 'playlists';
/** The folders under the data volume a playlist folder may be in. */
const ALLOWED_TOP = new Set(['playlists', 'library']);

type Ctx = Pick<HubContext, 'config' | 'repos' | 'library' | 'clock' | 'audit'>;

function norm(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Who did it, as the files record it: `admin`, or the device's id. */
export function playlistActor(principal: Principal): string {
  return principal.kind === 'device' ? principal.deviceId : 'admin';
}

/** How the data volume is shown: `/data` in the container. */
function shownDataDir(dataDir: string): string {
  return resolve(dataDir).replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * A typed folder as the stored relative form, or null: relative (`playlists/mine`), or written out
 * under the data volume (`/data/playlists/mine`). Each segment is plain letters, digits, spaces,
 * dots, dashes and underscores — the rule the backup folder follows.
 */
export function cleanFolderPath(typed: string, dataDir: string): string | null {
  const shown = shownDataDir(dataDir);
  let text = typed.trim().replaceAll('\\', '/');
  if (text.startsWith(`${shown}/`)) text = text.slice(shown.length + 1);
  else if (text.startsWith('/data/')) text = text.slice('/data/'.length);
  else if (/^([a-z]:|\/)/i.test(text)) return null;
  const segments = text.split('/').filter(Boolean);
  if (!segments.length || segments.some((s) => s === '.' || s === '..' || !/^[A-Za-z0-9 ._()-]{1,80}$/.test(s) || /^[ .]|[ .]$/.test(s))) return null;
  const cleaned = segments.join('/');
  return isSafeRelativePath(cleaned) ? cleaned : null;
}

export class HubPlaylists {
  readonly store: PlaylistFolderStore;
  private library: { byIsrc: Map<string, string>; byWords: Map<string, Array<{ path: string; durationMs: number | null }>>; byPath: Map<string, string> } | null = null;
  private libraryAt = 0;

  constructor(private readonly ctx: Ctx) {
    this.store = new PlaylistFolderStore({
      dir: () => this.absolute(this.relativePath()),
      allowedRoots: () => this.allowedRoots(),
      locate: (track) => this.locate(track),
      trackIdForPath: (path) => this.libraryIndex().byPath.get(resolve(path)) ?? null,
      now: () => ctx.clock.now(),
    });
  }

  relativePath(): string {
    return this.ctx.repos.settings.get<string>(PLAYLIST_FOLDER_SETTING) ?? DEFAULT_PLAYLIST_FOLDER;
  }

  private absolute(relativePath: string): string {
    return join(this.ctx.config.dataDir, ...relativePath.split('/'));
  }

  /** Where a relative location may point: the data volume, and the configuration-registered library roots. */
  private allowedRoots(): string[] {
    const roots = [this.ctx.config.dataDir];
    for (const root of this.ctx.library.listRoots()) {
      const abs = this.ctx.library.absoluteRootPath(root);
      if (abs) roots.push(abs);
    }
    return roots;
  }

  /** The library, indexed for matching songs to files; rebuilt at most every few seconds. */
  private libraryIndex(): NonNullable<HubPlaylists['library']> {
    const now = this.ctx.clock.now();
    if (this.library && now - this.libraryAt < 5_000) return this.library;
    const bases = new Map<string, string | null>();
    const byIsrc = new Map<string, string>();
    const byWords = new Map<string, Array<{ path: string; durationMs: number | null }>>();
    const byPath = new Map<string, string>();
    for (const rec of this.ctx.library.allTracks()) {
      if (rec.deletedAt) continue;
      if (!bases.has(rec.rootId)) {
        const root = this.ctx.library.listRoots().find((r) => r.id === rec.rootId);
        bases.set(rec.rootId, root ? this.ctx.library.absoluteRootPath(root) : null);
      }
      const base = bases.get(rec.rootId);
      if (!base || !isSafeRelativePath(rec.relativePath)) continue;
      const path = resolve(base, ...rec.relativePath.split('/'));
      byPath.set(path, rec.id);
      const isrc = rec.track.identity?.isrc;
      if (isrc) byIsrc.set(isrc.toUpperCase(), path);
      const words = `${norm(rec.track.artistName)}|${norm(rec.track.title)}`;
      byWords.set(words, [...(byWords.get(words) ?? []), { path, durationMs: rec.track.durationMs ?? null }]);
    }
    this.library = { byIsrc, byWords, byPath };
    this.libraryAt = now;
    return this.library;
  }

  /** The library file a song from search is: by ISRC, else the same artist and title within 3 s. */
  locate(track: CatalogTrack): string | null {
    const index = this.libraryIndex();
    if (track.isrc) {
      const hit = index.byIsrc.get(track.isrc.toUpperCase());
      if (hit) return hit;
    }
    const candidates = index.byWords.get(`${norm(track.artist)}|${norm(track.title)}`) ?? [];
    const near = candidates.find((c) => c.durationMs === null || track.durationMs === null || Math.abs(c.durationMs - track.durationMs) <= 3_000);
    return near?.path ?? null;
  }

  async info(): Promise<PlaylistFolderInfo> {
    const { scan } = await this.store.list();
    const relativePath = this.relativePath();
    return { path: `${shownDataDir(this.ctx.config.dataDir)}/${relativePath}`, relativePath, isDefault: relativePath === DEFAULT_PLAYLIST_FOLDER, available: scan.available, reason: scan.reason, playlistCount: scan.playlists.length, capped: scan.capped };
  }

  async list(probe: SongProbe): Promise<{ folder: PlaylistFolderInfo; items: FolderPlaylistSummary[] }> {
    const { scan, items } = await this.store.list(probe);
    const relativePath = this.relativePath();
    return { folder: { path: `${shownDataDir(this.ctx.config.dataDir)}/${relativePath}`, relativePath, isDefault: relativePath === DEFAULT_PLAYLIST_FOLDER, available: scan.available, reason: scan.reason, playlistCount: items.length, capped: scan.capped }, items };
  }

  /* ------------------------------------------------------------------ who may */

  /** Renaming, reordering and deleting: the admin, or the device that made the list. */
  assertOwner(principal: Principal, playlist: LoadedPlaylist): void {
    if (principal.kind === 'admin') return;
    if (principal.kind === 'device' && playlist.createdBy === principal.deviceId) return;
    throw new DomainError('forbidden', `Only the hub admin, or the device that made it, may change “${playlist.name}” that way.`);
  }

  /** Removing: the admin; the device that made the list; or a device taking out songs it added itself. */
  removalRule(principal: Principal, playlist: LoadedPlaylist): ((entry: { addedBy: string | null }) => boolean) | undefined {
    if (principal.kind === 'admin') return undefined;
    if (principal.kind === 'device' && playlist.createdBy === principal.deviceId) return undefined;
    const id = principal.kind === 'device' ? principal.deviceId : '\u0000';
    return (entry) => entry.addedBy === id;
  }

  /* ------------------------------------------------------------------ the folder */

  /**
   * Keep playlists somewhere else under the data volume: `playlists/…` or `library/…`. The path is
   * checked as text (no traversal, no drive, no reserved name), then again once made, by its real path,
   * so a symbolic link inside the volume cannot lead out of it.
   */
  async changeFolder(typed: string, move: boolean): Promise<{ folder: PlaylistFolderInfo; moved: number; failed: string[] }> {
    const relativePath = cleanFolderPath(typed, this.ctx.config.dataDir);
    if (!relativePath || !ALLOWED_TOP.has(relativePath.split('/')[0] ?? '')) {
      const shown = shownDataDir(this.ctx.config.dataDir);
      throw new DomainError('validation', `Playlists can be kept in a folder inside the hub’s data volume, under ${shown}/playlists or ${shown}/library — for example “playlists” or “library/Playlists”.`);
    }
    const target = this.absolute(relativePath);
    await mkdir(target, { recursive: true });
    let real: string;
    let dataReal: string;
    try {
      real = realpathSync(target);
      dataReal = realpathSync(this.ctx.config.dataDir);
    } catch {
      throw new DomainError('validation', 'That folder can’t be used.');
    }
    if (!isInsideRoot(dataReal, real)) throw new DomainError('validation', 'That folder leads outside the hub’s data volume.');
    const result = move ? await this.store.moveAllTo(target) : { moved: 0, failed: [] as string[] };
    this.ctx.repos.settings.set(PLAYLIST_FOLDER_SETTING, relativePath, new Date(this.ctx.clock.now()).toISOString());
    return { folder: await this.info(), ...result };
  }
}
