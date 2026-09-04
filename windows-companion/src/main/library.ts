/**
 * Scanning a Windows music folder.
 *
 * Three details make this survive a real library rather than a test one:
 *
 * - **Change detection by size and mtime.** A rescan of 80,000 files that have not changed reads no
 *   tags and writes no rows, so it takes seconds rather than an hour and does not churn `updatedAt`
 *   (which would make a hub think the whole library changed).
 * - **Every failure is per-file.** A locked file, a corrupt header or a permission error removes one
 *   track from the scan, not the scan.
 * - **Paths stay here.** The absolute path is used to open the file and is never written into the
 *   `Track` — the locator carries the folder id and the relative path instead.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parseFile } from 'music-metadata';
import type { AudioFormat, Track, TrackIdentity } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { CompanionStore, StoredTrack } from './store.js';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wave', '.wma', '.aiff', '.aif', '.alac', '.ape', '.wv', '.mpc', '.dsf', '.dff']);

/** Directories that never contain a user's music and cost real time to walk. */
const SKIP_DIRECTORIES = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git', '.svn', 'AppData', 'Windows']);
const MAX_DEPTH = 16;
/** Enough of a file to identify it without reading gigabytes: first and last 1 MB plus the size. */
const QUICK_HASH_BYTES = 1024 * 1024;

export interface ScanCallbacks {
  onProgress?: (progress: { found: number; indexed: number; skipped: number; currentName: string | null }) => void;
  signal?: AbortSignal;
}

export interface FolderScanResult {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  sizeBytes: number;
  unreadable: Array<{ relativePath: string; reason: string }>;
}

export async function* walk(root: string, current = root, depth = 0): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    // An unreadable directory (permissions, a disconnected share) is skipped, not fatal.
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) continue; // A symlink loop would walk forever.
    if (entry.isDirectory()) {
      yield* walk(root, absolutePath, depth + 1);
    } else if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield { absolutePath, relativePath: relative(root, absolutePath).split(sep).join('/') };
    }
  }
}

/**
 * A cheap, stable identifier for a file's *contents*, used to recognise the same song already on a
 * hub without hashing gigabytes. Full SHA-256 is computed only when a transfer needs it.
 */
export async function quickHash(absolutePath: string, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  hash.update(String(sizeBytes));
  const readSlice = (start: number, end: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const stream = createReadStream(absolutePath, { start, end });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve());
    });
  await readSlice(0, Math.min(QUICK_HASH_BYTES, sizeBytes) - 1);
  if (sizeBytes > QUICK_HASH_BYTES * 2) await readSlice(sizeBytes - QUICK_HASH_BYTES, sizeBytes - 1);
  return hash.digest('hex');
}

export async function fullHash(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function readTrack(absolutePath: string, relativePath: string, folderId: string, existingId?: string): Promise<Track> {
  const now = new Date().toISOString();
  const stats = await stat(absolutePath);
  let title = relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Unknown';
  let artistName = 'Unknown Artist';
  let albumName: string | null = null;
  let albumArtistName: string | null = null;
  let year: number | null = null;
  let genre: string | null = null;
  const genres: string[] = [];
  let trackNumber: number | null = null;
  let discNumber: number | null = null;
  let durationMs: number | null = null;
  let bpm: number | null = null;
  // Assigned on both paths below (parsed tags, or the size-only fallback in the catch).
  let format: AudioFormat;
  const identity: TrackIdentity = { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} };

  try {
    const metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
    const common = metadata.common;
    if (common.title?.trim()) title = common.title.trim();
    if (common.artist?.trim()) artistName = common.artist.trim();
    albumName = common.album?.trim() ?? null;
    albumArtistName = common.albumartist?.trim() ?? null;
    year = typeof common.year === 'number' && common.year > 0 ? common.year : null;
    genre = common.genre?.[0]?.trim() ?? null;
    for (const g of common.genre ?? []) if (g.trim()) genres.push(g.trim());
    trackNumber = common.track?.no ?? null;
    discNumber = common.disk?.no ?? null;
    bpm = typeof common.bpm === 'number' && common.bpm > 0 ? common.bpm : null;
    if (common.isrc?.[0]) identity.isrc = common.isrc[0];
    if (common.musicbrainz_recordingid) identity.musicbrainzRecordingId = common.musicbrainz_recordingid;
    const info = metadata.format;
    durationMs = info.duration ? Math.round(info.duration * 1000) : null;
    format = {
      ...(info.container ? { container: info.container } : {}),
      ...(info.codec ? { codec: info.codec } : {}),
      ...(info.sampleRate ? { sampleRateHz: Math.round(info.sampleRate) } : {}),
      ...(info.bitrate ? { bitrateKbps: Math.round(info.bitrate / 1000) } : {}),
      ...(info.numberOfChannels ? { channels: info.numberOfChannels } : {}),
      ...(info.lossless !== undefined ? { lossless: info.lossless } : {}),
      sizeBytes: stats.size,
    };
  } catch {
    // No readable tags: the filename and the extension are still true, so the track exists.
    format = { sizeBytes: stats.size };
  }

  identity.quickHash = await quickHash(absolutePath, stats.size).catch(() => null);

  return {
    id: existingId ?? uuidv7(),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    title,
    artistId: null,
    artistName,
    albumId: null,
    albumName,
    albumArtistName,
    discNumber,
    trackNumber,
    genre,
    genres,
    tags: [],
    year,
    durationMs,
    bpm,
    identity,
    // The folder id plus a relative path: enough for this machine to find the file, and useless to
    // anyone else — which is the point.
    locators: [{ kind: 'windows-file', deviceId: folderId, fileId: relativePath }],
    artworkId: null,
    format,
    rootId: null,
    unsupportedReason: null,
    liked: false,
    explicit: null,
    popularity: null,
  };
}

export async function scanFolder(store: CompanionStore, folder: { id: string; path: string }, callbacks: ScanCallbacks = {}): Promise<FolderScanResult> {
  const result: FolderScanResult = { added: 0, updated: 0, removed: 0, skipped: 0, sizeBytes: 0, unreadable: [] };
  const existing = store.pathsInFolder(folder.id);
  const seen = new Set<string>();
  let found = 0;

  for await (const file of walk(folder.path)) {
    if (callbacks.signal?.aborted) break;
    found += 1;
    seen.add(file.relativePath);
    let stats;
    try {
      stats = await stat(file.absolutePath);
    } catch (err) {
      result.unreadable.push({ relativePath: file.relativePath, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.sizeBytes += stats.size;

    const previous = existing.get(file.relativePath);
    if (previous && previous.sizeBytes === stats.size && previous.mtimeMs === Math.round(stats.mtimeMs)) {
      result.skipped += 1;
      callbacks.onProgress?.({ found, indexed: result.added + result.updated, skipped: result.skipped, currentName: file.relativePath });
      continue;
    }

    try {
      const track = await readTrack(file.absolutePath, file.relativePath, folder.id, previous?.id);
      const record: StoredTrack = {
        id: track.id,
        folderId: folder.id,
        relativePath: file.relativePath,
        track,
        sizeBytes: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
        contentHash: track.identity.quickHash,
        updatedAt: track.updatedAt,
        deletedAt: null,
      };
      store.upsertTrack(record);
      if (previous) result.updated += 1;
      else result.added += 1;
    } catch (err) {
      result.unreadable.push({ relativePath: file.relativePath, reason: err instanceof Error ? err.message : String(err) });
    }
    callbacks.onProgress?.({ found, indexed: result.added + result.updated, skipped: result.skipped, currentName: file.relativePath });
  }

  if (!callbacks.signal?.aborted) {
    const now = new Date().toISOString();
    for (const [path, record] of existing) {
      if (seen.has(path)) continue;
      store.tombstone(record.id, now);
      result.removed += 1;
    }
  }

  store.updateFolderStats(folder.id, { trackCount: seen.size, sizeBytes: result.sizeBytes, lastScanAt: new Date().toISOString(), error: null });
  return result;
}

/**
 * The absolute path of a track, resolved only inside the main process.
 *
 * The containment check compares whole path segments. A plain `startsWith` would accept
 * `C:\\MusicSecret\\x.mp3` as being inside `C:\\Music`, which is how directory-traversal bugs
 * usually look: the prefix matches, the directory does not.
 */
export function absolutePathOf(store: CompanionStore, trackId: string): string | null {
  const record = store.findTrack(trackId);
  if (!record) return null;
  const folder = store.findFolder(record.folderId);
  if (!folder) return null;
  const root = resolve(folder.path);
  const resolved = resolve(root, ...record.relativePath.split('/'));
  return isInside(root, resolved) ? resolved : null;
}

/** True when `candidate` is `root` itself or sits beneath it, comparing whole segments. */
export function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base) return true;
  const withSeparator = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(withSeparator);
}
