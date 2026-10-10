/**
 * A folder of playlists, read and written (DEC-041). Node only: imported as
 * `@now-playing/domain/playlist-folder` by the hub and the companion's main process, never from the
 * package index the player bundles for the browser.
 *
 * - **Rescanned on every read.** A file is parsed again only when its size or modification time (or
 *   its sidecar's) changed, so a list edited in another player, or a `.m3u` dropped in by hand, shows
 *   up the next time anything is opened.
 * - **Atomic writes.** Each file is written to a temporary name beside it and renamed over the old
 *   one: a reader sees the old list or the new one, never half of one. Writes run one at a time.
 * - **Nothing escapes the folder.** File names are sanitised (`sanitizeFilename`) and made unique;
 *   symbolic links in the folder are not followed; a relative location is only looked at when it
 *   resolves inside the allowed roots; absolute paths are never written and never followed.
 * - **Caps.** `PLAYLIST_FOLDER_PLAYLIST_CAP` lists per folder, `PLAYLIST_FOLDER_ENTRY_CAP` songs per
 *   list, 16 MB per M3U and 64 MB per sidecar.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLAYLIST_FOLDER_ENTRY_CAP, PLAYLIST_FOLDER_PLAYLIST_CAP, PLAYLIST_SIDECAR_SUFFIX, PlaylistSidecar, type CatalogTrack, type FolderPlaylistEntry, type FolderPlaylistSummary, type PlaylistSidecarEntry } from '@now-playing/contracts';
import { DomainError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import { bestSourceUrl, buildSidecar, handMadeId, isAbsoluteLocation, isUrlLocation, mosaicOf, oneLine, parsePlaylistM3u, playlistFileBase, reconcile, sameSong, serializePlaylistM3u, sidecarEntryFor } from './format.js';

const M3U_MAX_BYTES = 16 * 1024 * 1024;
const SIDECAR_MAX_BYTES = 64 * 1024 * 1024;
const PLAYLIST_FILE = /\.m3u8?$/i;

export interface PlaylistFolderStoreOptions {
  /** The folder, as it is now (it can change: Settings ▸ playlist folder). */
  dir: () => string;
  /** Other folders a relative location may point into: the library's. The playlist folder is always one. */
  allowedRoots?: () => readonly string[];
  /** The library file a song is, when the library has it: an absolute path. */
  locate?: (track: CatalogTrack) => string | null;
  /** The library's id for a file, by its absolute path. */
  trackIdForPath?: (absolutePath: string) => string | null;
  now?: () => number;
  newId?: () => string;
  playlistCap?: number;
  entryCap?: number;
}

/** What one playlist is, read: its files, its fields and its entries in M3U order. */
export interface LoadedPlaylist {
  fileName: string;
  base: string;
  id: string;
  name: string;
  description: string | null;
  createdAt: string | null;
  updatedAt: string;
  createdBy: string | null;
  origin: 'airwave' | 'hand-made';
  entries: PlaylistSidecarEntry[];
}

interface Cached {
  key: string;
  playlist: LoadedPlaylist;
}

export interface FolderScan {
  dir: string;
  available: boolean;
  reason: string | null;
  playlists: LoadedPlaylist[];
  capped: boolean;
}

export interface SongProbe {
  catalogId?: string | null | undefined;
  isrc?: string | null | undefined;
}

/** True when `candidate` is `root` or beneath it, comparing whole segments (case-insensitively on Windows). */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Write a file by writing a temporary one beside it and renaming it over the old one. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function summaryOf(p: LoadedPlaylist, probe?: SongProbe): FolderPlaylistSummary {
  const asked = Boolean(probe?.catalogId || probe?.isrc);
  return {
    id: p.id,
    name: p.name,
    fileName: p.fileName,
    description: p.description,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    entryCount: p.entries.length,
    durationSec: p.entries.reduce((sum, e) => sum + (e.durationSec ?? 0), 0),
    covers: mosaicOf(p.entries),
    origin: p.origin,
    readOnly: p.origin === 'hand-made',
    createdBy: p.createdBy,
    hasTrack: asked ? p.entries.some((e) => sameSong(e, probe!)) : null,
  };
}

/** A file that is there and is a file; anything unreadable is not. */
function isPlainFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export class PlaylistFolderStore {
  private readonly cache = new Map<string, Cached>();
  private cachedDir: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly playlistCap: number;
  private readonly entryCap: number;

  constructor(private readonly options: PlaylistFolderStoreOptions) {
    this.playlistCap = options.playlistCap ?? PLAYLIST_FOLDER_PLAYLIST_CAP;
    this.entryCap = options.entryCap ?? PLAYLIST_FOLDER_ENTRY_CAP;
  }

  dir(): string {
    return resolve(this.options.dir());
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  private newId(): string {
    return this.options.newId?.() ?? uuidv7(this.options.now?.());
  }

  /** One write at a time; reads that need a consistent view take the same turn. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /* ------------------------------------------------------------------ reading */

  /** Read the folder: every playlist file, parsed again only when it changed. */
  async scan(): Promise<FolderScan> {
    const dir = this.dir();
    if (this.cachedDir !== dir) {
      this.cache.clear();
      this.cachedDir = dir;
    }
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      return { dir, available: false, reason: `The playlist folder can’t be made: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`, playlists: [], capped: false };
    }
    let names: string[];
    try {
      const listing = await readdir(dir, { withFileTypes: true });
      // A symbolic link is not followed: it could point at anything on the disk.
      names = listing.filter((d) => d.isFile() && PLAYLIST_FILE.test(d.name)).map((d) => d.name);
    } catch (err) {
      return { dir, available: false, reason: `The playlist folder can’t be read: ${(err as NodeJS.ErrnoException).code ?? String(err)}.`, playlists: [], capped: false };
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
    const capped = names.length > this.playlistCap;
    const seen = new Set<string>();
    const playlists: LoadedPlaylist[] = [];
    for (const fileName of names.slice(0, this.playlistCap)) {
      seen.add(fileName);
      const loaded = await this.load(dir, fileName).catch(() => null);
      if (!loaded) continue;
      // Two files claiming one id (a sidecar copied by hand): the second is shown under its own.
      if (playlists.some((p) => p.id === loaded.id)) loaded.id = handMadeId(fileName);
      playlists.push(loaded);
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return { dir, available: true, reason: null, playlists, capped };
  }

  private async load(dir: string, fileName: string): Promise<LoadedPlaylist | null> {
    const file = join(dir, fileName);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > M3U_MAX_BYTES) return null;
    const base = fileName.replace(PLAYLIST_FILE, '');
    const sidecarFile = join(dir, `${base}${PLAYLIST_SIDECAR_SUFFIX}`);
    const sidecarStat = await lstat(sidecarFile).catch(() => null);
    const sidecarUsable = sidecarStat?.isFile() && sidecarStat.size <= SIDECAR_MAX_BYTES ? sidecarStat : null;
    const key = `${stat.size}:${stat.mtimeMs}:${sidecarUsable ? `${sidecarUsable.size}:${sidecarUsable.mtimeMs}` : '-'}`;
    const cached = this.cache.get(fileName);
    if (cached?.key === key) return { ...cached.playlist, entries: cached.playlist.entries };
    const parsed = parsePlaylistM3u(await readFile(file, 'utf8'), this.entryCap);
    let sidecar: PlaylistSidecar | null = null;
    if (sidecarUsable) {
      try {
        const check = PlaylistSidecar.safeParse(JSON.parse(await readFile(sidecarFile, 'utf8')));
        sidecar = check.success ? check.data : null;
      } catch {
        sidecar = null;
      }
    }
    const playlist: LoadedPlaylist = {
      fileName,
      base,
      id: sidecar?.id ?? handMadeId(fileName),
      name: sidecar?.name ?? parsed.name ?? base,
      description: sidecar?.description ?? null,
      createdAt: sidecar?.createdAt ?? null,
      updatedAt: sidecar?.updatedAt ?? new Date(stat.mtimeMs).toISOString(),
      createdBy: sidecar?.createdBy ?? null,
      origin: sidecar ? 'airwave' : 'hand-made',
      entries: reconcile(parsed, sidecar),
    };
    this.cache.set(fileName, { key, playlist });
    return { ...playlist };
  }

  async list(probe?: SongProbe): Promise<{ scan: FolderScan; items: FolderPlaylistSummary[] }> {
    const scan = await this.scan();
    return { scan, items: scan.playlists.map((p) => summaryOf(p, probe)) };
  }

  /** One playlist, read now, or a not-found error. */
  async get(id: string): Promise<LoadedPlaylist> {
    const scan = await this.scan();
    if (!scan.available) throw new DomainError('unavailable', scan.reason ?? 'The playlist folder can’t be read.');
    const found = scan.playlists.find((p) => p.id === id);
    if (!found) throw new DomainError('not-found', 'That playlist isn’t in the playlist folder any more.');
    return found;
  }

  summary(playlist: LoadedPlaylist, probe?: SongProbe): FolderPlaylistSummary {
    return summaryOf(playlist, probe);
  }

  async page(id: string, offset: number, limit: number): Promise<{ playlist: FolderPlaylistSummary; items: FolderPlaylistEntry[]; offset: number; total: number; hasMore: boolean }> {
    const playlist = await this.get(id);
    const items = playlist.entries.slice(offset, offset + limit).map((e) => this.resolveEntry(e));
    return { playlist: summaryOf(playlist), items, offset, total: playlist.entries.length, hasMore: offset + items.length < playlist.entries.length };
  }

  private roots(): string[] {
    return [this.dir(), ...(this.options.allowedRoots?.() ?? [])].map((r) => resolve(r));
  }

  /** Where an entry plays from, checked: a library file inside the allowed roots, a URL, or missing. */
  private resolveEntry(entry: PlaylistSidecarEntry): FolderPlaylistEntry {
    const base = { ...entry, trackId: null as string | null };
    const location = entry.location;
    if (!location) return { ...base, location: null, locationKind: 'missing' };
    if (isUrlLocation(location)) return { ...base, locationKind: 'url' };
    // An absolute path (a hand-made list's "C:\Music\…") is neither shown nor followed.
    if (isAbsoluteLocation(location)) return { ...base, location: null, locationKind: 'missing' };
    const absolute = resolve(this.dir(), ...location.split(/[\\/]+/).filter(Boolean));
    if (!this.roots().some((root) => isInsideRoot(root, absolute))) return { ...base, locationKind: 'missing' };
    if (!isPlainFile(absolute)) return { ...base, locationKind: 'missing' };
    return { ...base, locationKind: 'library', trackId: this.options.trackIdForPath?.(absolute) ?? null };
  }

  /** The playlist's .m3u8 as it is on disk (the export). */
  async exportText(id: string): Promise<{ fileName: string; text: string }> {
    const playlist = await this.get(id);
    const text = await readFile(join(this.dir(), playlist.fileName), 'utf8');
    return { fileName: playlist.fileName.replace(/\.m3u$/i, '.m3u8'), text: text.startsWith('#EXTM3U') ? text : `#EXTM3U\n${text}` };
  }

  /* ------------------------------------------------------------------ writing */

  /** Bases (lower-cased) already taken by a playlist or a sidecar file, leaving out the files named (a playlist's own). */
  private async takenBases(exceptFiles: readonly string[] = []): Promise<Set<string>> {
    const except = new Set(exceptFiles.map((f) => f.toLowerCase()));
    const taken = new Set<string>();
    for (const name of await readdir(this.dir()).catch(() => [] as string[])) {
      const lower = name.toLowerCase();
      if (except.has(lower)) continue;
      if (PLAYLIST_FILE.test(lower)) taken.add(lower.replace(PLAYLIST_FILE, ''));
      else if (lower.endsWith(PLAYLIST_SIDECAR_SUFFIX)) taken.add(lower.slice(0, -PLAYLIST_SIDECAR_SUFFIX.length));
    }
    return taken;
  }

  /** A sanitised file base for a name that no other playlist (or sidecar) in the folder uses. */
  private async uniqueBase(name: string, own?: LoadedPlaylist): Promise<string> {
    const wanted = playlistFileBase(name);
    const taken = await this.takenBases(own ? [own.fileName, `${own.base}${PLAYLIST_SIDECAR_SUFFIX}`] : []);
    if (!taken.has(wanted.toLowerCase())) return wanted;
    for (let n = 2; n < 10_000; n++) {
      const candidate = `${wanted.slice(0, 110)} (${n})`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    throw new DomainError('conflict', 'There are too many playlists with that name.');
  }

  /** Write both files for a playlist under `base` (sidecar first: the M3U is what readers trust). */
  private async write(playlist: LoadedPlaylist, base: string, withSidecar = true): Promise<string> {
    const dir = this.dir();
    const fileName = `${base}.m3u8`;
    if (withSidecar) {
      const sidecar = buildSidecar({ id: playlist.id, name: playlist.name, description: playlist.description, createdAt: playlist.createdAt ?? playlist.updatedAt, updatedAt: playlist.updatedAt, createdBy: playlist.createdBy, entries: playlist.entries });
      await writeFileAtomic(join(dir, `${base}${PLAYLIST_SIDECAR_SUFFIX}`), JSON.stringify(sidecar, null, 2) + '\n');
    }
    const m3u = serializePlaylistM3u(
      playlist.name,
      playlist.entries.map((e) => ({ location: e.location ?? '', durationSec: e.durationSec, artist: e.artist, title: e.title })).filter((e) => e.location),
    );
    await writeFileAtomic(join(dir, fileName), m3u);
    this.cache.delete(fileName);
    this.cache.delete(playlist.fileName);
    return fileName;
  }

  /** Remove a playlist's M3U and, when named, its sidecar. Never anything but those two. */
  private async unlinkFiles(fileName: string, sidecarBase: string | null): Promise<void> {
    const dir = this.dir();
    await unlink(join(dir, fileName)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    if (sidecarBase !== null) await unlink(join(dir, `${sidecarBase}${PLAYLIST_SIDECAR_SUFFIX}`)).catch(() => undefined);
    this.cache.delete(fileName);
  }

  /**
   * Save a changed playlist. A hand-made list is adopted here: written as .m3u8 with a sidecar, under
   * the same id, and its old file (a .m3u, say) removed.
   */
  private async save(playlist: LoadedPlaylist, rename?: string): Promise<LoadedPlaylist> {
    const wasHandMade = playlist.origin === 'hand-made';
    const oldFileName = playlist.fileName;
    const oldBase = playlist.base;
    const keepName = !rename && /\.m3u8$/i.test(oldFileName);
    const base = keepName ? oldBase : await this.uniqueBase(rename ?? playlist.name, playlist);
    const next: LoadedPlaylist = { ...playlist, origin: 'airwave', updatedAt: this.nowIso(), createdAt: playlist.createdAt ?? (wasHandMade ? this.nowIso() : null) };
    const fileName = await this.write(next, base);
    // The old files go once the new ones are written; a sidecar that kept its name stays.
    if (fileName.toLowerCase() !== oldFileName.toLowerCase()) await this.unlinkFiles(oldFileName, oldBase.toLowerCase() === base.toLowerCase() ? null : oldBase);
    return { ...next, fileName, base };
  }

  async create(input: { name: string; description?: string | null | undefined; tracks?: readonly CatalogTrack[] }, actor: string | null): Promise<FolderPlaylistSummary> {
    return this.exclusive(async () => {
      const scan = await this.scan();
      if (!scan.available) throw new DomainError('unavailable', scan.reason ?? 'The playlist folder can’t be written.');
      if (scan.playlists.length >= this.playlistCap || scan.capped) throw new DomainError('conflict', `The playlist folder already holds ${this.playlistCap} playlists. Delete some first.`);
      const name = oneLine(input.name);
      if (!name) throw new DomainError('validation', 'A playlist needs a name.');
      const now = this.nowIso();
      const tracks = (input.tracks ?? []).slice(0, this.entryCap);
      const entries: PlaylistSidecarEntry[] = [];
      for (const track of tracks) {
        const entry = this.entryFor(track, now, actor);
        if (!entries.some((e) => sameSong(e, entry))) entries.push(entry);
      }
      const base = await this.uniqueBase(name);
      const playlist: LoadedPlaylist = { fileName: `${base}.m3u8`, base, id: this.newId(), name, description: input.description?.trim() || null, createdAt: now, updatedAt: now, createdBy: actor, origin: 'airwave', entries };
      const fileName = await this.write(playlist, base);
      return summaryOf({ ...playlist, fileName });
    });
  }

  /** A song from search as an entry: a relative path when the library has the file, else its best source URL. */
  private entryFor(track: CatalogTrack, now: string, actor: string | null): PlaylistSidecarEntry {
    let location: string | null = null;
    const file = this.options.locate?.(track) ?? null;
    if (file) {
      const rel = relative(this.dir(), resolve(file));
      // Another drive cannot be reached relatively; then the song is filed by its source instead.
      if (rel && !isAbsolute(rel)) location = rel.split(sep).join('/');
    }
    location ??= bestSourceUrl(track);
    return sidecarEntryFor(track, location, this.newId(), now, actor);
  }

  async update(id: string, patch: { name?: string | undefined; description?: string | null | undefined }): Promise<FolderPlaylistSummary> {
    return this.exclusive(async () => {
      const playlist = await this.get(id);
      const name = patch.name !== undefined ? oneLine(patch.name) : playlist.name;
      if (!name) throw new DomainError('validation', 'A playlist needs a name.');
      const renamed = name !== playlist.name;
      const next = { ...playlist, name, description: patch.description !== undefined ? patch.description?.trim() || null : playlist.description };
      return summaryOf(await this.save(next, renamed ? name : undefined));
    });
  }

  async delete(id: string): Promise<void> {
    return this.exclusive(async () => {
      const playlist = await this.get(id);
      await this.unlinkFiles(playlist.fileName, playlist.base);
    });
  }

  async add(id: string, tracks: readonly CatalogTrack[], options: { position?: number | undefined; allowDuplicates?: boolean | undefined }, actor: string | null): Promise<{ playlist: FolderPlaylistSummary; added: number; skipped: number }> {
    return this.exclusive(async () => {
      const playlist = await this.get(id);
      const now = this.nowIso();
      const fresh: PlaylistSidecarEntry[] = [];
      let skipped = 0;
      for (const track of tracks) {
        const entry = this.entryFor(track, now, actor);
        const known = [...playlist.entries, ...fresh].some((e) => sameSong(e, entry));
        if (known && !options.allowDuplicates) skipped++;
        else fresh.push(entry);
      }
      if (playlist.entries.length + fresh.length > this.entryCap) throw new DomainError('validation', `A playlist holds at most ${this.entryCap.toLocaleString('en')} songs; “${playlist.name}” has ${playlist.entries.length.toLocaleString('en')}.`);
      if (!fresh.length) return { playlist: summaryOf(playlist), added: 0, skipped };
      const at = Math.min(options.position ?? playlist.entries.length, playlist.entries.length);
      const entries = [...playlist.entries.slice(0, at), ...fresh, ...playlist.entries.slice(at)];
      const saved = await this.save({ ...playlist, entries });
      return { playlist: summaryOf(saved), added: fresh.length, skipped };
    });
  }

  async removeEntries(id: string, entryIds: readonly string[], allowed?: (entry: PlaylistSidecarEntry) => boolean): Promise<FolderPlaylistSummary> {
    return this.exclusive(async () => {
      const playlist = await this.get(id);
      const ids = new Set(entryIds);
      const targets = playlist.entries.filter((e) => ids.has(e.id));
      if (!targets.length) throw new DomainError('not-found', 'Those songs aren’t in the playlist any more.');
      if (allowed && !targets.every(allowed)) throw new DomainError('forbidden', 'This device may only remove songs it added, from a playlist it did not make.');
      const saved = await this.save({ ...playlist, entries: playlist.entries.filter((e) => !ids.has(e.id)) });
      return summaryOf(saved);
    });
  }

  async move(id: string, entryId: string, to: number): Promise<FolderPlaylistSummary> {
    return this.exclusive(async () => {
      const playlist = await this.get(id);
      const from = playlist.entries.findIndex((e) => e.id === entryId);
      if (from < 0) throw new DomainError('not-found', 'That song isn’t in the playlist any more.');
      const entries = [...playlist.entries];
      const [entry] = entries.splice(from, 1);
      entries.splice(Math.min(Math.max(0, to), entries.length), 0, entry!);
      return summaryOf(await this.save({ ...playlist, entries }));
    });
  }

  /**
   * Move every playlist into another folder. Relative locations are worked out again from the new
   * folder, so a song in the library still resolves; a hand-made list stays hand-made (no sidecar).
   * The old files are removed only once the new ones are written.
   */
  async moveAllTo(target: string): Promise<{ moved: number; failed: string[] }> {
    return this.exclusive(async () => {
      const from = this.dir();
      const to = resolve(target);
      if (from.toLowerCase() === to.toLowerCase()) return { moved: 0, failed: [] };
      const scan = await this.scan();
      await mkdir(to, { recursive: true });
      const destination = new PlaylistFolderStore({ ...this.options, dir: () => to });
      let moved = 0;
      const failed: string[] = [];
      for (const playlist of scan.playlists) {
        try {
          const entries = playlist.entries.map((e) => {
            if (!e.location || isUrlLocation(e.location) || isAbsoluteLocation(e.location)) return e;
            const absolute = resolve(from, ...e.location.split(/[\\/]+/).filter(Boolean));
            const rel = relative(to, absolute);
            return rel && !isAbsolute(rel) ? { ...e, location: rel.split(sep).join('/') } : e;
          });
          const base = await destination.uniqueBase(playlist.base);
          await destination.write({ ...playlist, entries }, base, playlist.origin === 'airwave');
          await this.unlinkFiles(playlist.fileName, playlist.base);
          moved++;
        } catch {
          failed.push(playlist.name.slice(0, 300));
        }
      }
      this.cache.clear();
      return { moved, failed: failed.slice(0, 50) };
    });
  }
}
