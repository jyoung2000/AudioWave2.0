/**
 * Building the library from files on the device.
 *
 * The browser gives us two very different capabilities, and the player uses whichever it has while
 * being honest about the difference:
 *
 * - **File System Access** (Chromium, and Safari for OPFS): a directory handle that survives a
 *   restart, so a folder stays connected and can be rescanned. Nothing is copied.
 * - **A plain file picker** (Firefox, Safari): files are readable for this session only. The player
 *   indexes their metadata so the library still looks right after a reload, and marks those tracks
 *   as needing the folder to be re-picked rather than pretending they will play.
 *
 * Tags are read with `music-metadata` from the first ~256 KB of each file, which is enough for
 * ID3/Vorbis/MP4 headers and avoids reading a gigabyte to learn a title.
 */
import { parseBlob } from 'music-metadata';
import type { AudioFormat, Track, TrackIdentity } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { PlayerDatabase, StoredFileRef, StoredRoot } from './db.js';

/** Extensions worth trying. The browser decides what it can actually decode; see `probeSupport`. */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wave', '.webm', '.aiff', '.aif', '.alac', '.wma'] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.webm': 'audio/webm',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.alac': 'audio/mp4; codecs=alac',
  '.wma': 'audio/x-ms-wma',
};

/** Enough bytes for a tag header plus embedded art, without reading the whole file. */
const TAG_BYTES = 512 * 1024;
const MAX_DEPTH = 12;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

export function isAudioFile(name: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * What this browser can decode, asked once. A format the browser refuses is still listed in the
 * library — the file exists — but carries `unsupportedReason` so the UI can explain rather than
 * failing at the moment someone presses play.
 */
export function probeSupport(audio: HTMLAudioElement = document.createElement('audio')): Map<string, boolean> {
  const support = new Map<string, boolean>();
  for (const [extension, mime] of Object.entries(MIME_BY_EXTENSION)) {
    const answer = audio.canPlayType(mime);
    support.set(extension, answer === 'probably' || answer === 'maybe');
  }
  return support;
}

export interface ScanProgress {
  found: number;
  indexed: number;
  skipped: number;
  currentPath: string | null;
}

export interface ScanResult {
  rootId: string;
  added: number;
  updated: number;
  removed: number;
  unreadable: Array<{ path: string; reason: string }>;
}

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /** Overrides the format probe (tests). */
  support?: Map<string, boolean>;
}

interface FoundFile {
  file: File;
  relativePath: string;
}

/** Walk a directory handle, depth-limited, yielding audio files with their relative paths. */
export async function* walkDirectory(directory: FileSystemDirectoryHandle, prefix = '', depth = 0): AsyncGenerator<FoundFile> {
  if (depth > MAX_DEPTH) return;
  for await (const [name, handle] of directory.entries()) {
    if (name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      yield* walkDirectory(handle as FileSystemDirectoryHandle, path, depth + 1);
    } else if (isAudioFile(name)) {
      try {
        yield { file: await (handle as FileSystemFileHandle).getFile(), relativePath: path };
      } catch {
        // A file that vanished or is locked by another program is simply not part of this scan.
      }
    }
  }
}

/**
 * Read one file into a `Track`. Everything is best effort: a file whose tags are unreadable still
 * becomes a track named after its filename, because the alternative — hiding it — makes the library
 * silently incomplete.
 */
export async function trackFromFile(file: File, relativePath: string, rootId: string, support: Map<string, boolean>, existingId?: string): Promise<{ track: Track; artwork: { blob: Blob; mime: string } | null }> {
  const now = new Date().toISOString();
  const extension = extensionOf(file.name);
  const id = existingId ?? uuidv7();
  let title = file.name.replace(/\.[^.]+$/, '');
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
  let format: AudioFormat | null;
  let artwork: { blob: Blob; mime: string } | null = null;
  const identity: TrackIdentity = { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} };

  try {
    // A slice is enough for the header; `duration: true` would otherwise decode the whole file.
    const head = file.slice(0, Math.min(TAG_BYTES, file.size));
    const metadata = await parseBlob(head, { duration: false, skipCovers: false });
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
    const picture = common.picture?.[0];
    if (picture) artwork = { blob: new Blob([picture.data as unknown as BlobPart], { type: picture.format }), mime: picture.format };
    const info = metadata.format;
    durationMs = info.duration ? Math.round(info.duration * 1000) : null;
    format = {
      ...(info.container ? { container: info.container } : {}),
      ...(info.codec ? { codec: info.codec } : {}),
      ...(file.type || MIME_BY_EXTENSION[extension] ? { mime: file.type || MIME_BY_EXTENSION[extension]! } : {}),
      ...(info.sampleRate ? { sampleRateHz: Math.round(info.sampleRate) } : {}),
      ...(info.bitrate ? { bitrateKbps: Math.round(info.bitrate / 1000) } : {}),
      ...(info.numberOfChannels ? { channels: info.numberOfChannels } : {}),
      ...(info.lossless !== undefined ? { lossless: info.lossless } : {}),
      sizeBytes: file.size,
    };
  } catch {
    // Unreadable tags: the filename and the extension are still true.
    format = { ...(MIME_BY_EXTENSION[extension] ? { mime: MIME_BY_EXTENSION[extension]! } : {}), sizeBytes: file.size };
  }

  const playable = support.get(extension) ?? true;
  const track: Track = {
    id,
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
    // `browser-handle` is the locator kind for a file the browser can reopen; the handle id is
    // the path *relative to the connected folder*, never an absolute one (docs/PRIVACY.md).
    locators: [{ kind: 'browser-handle', deviceId: rootId, handleId: relativePath }],
    artworkId: null,
    format,
    rootId: null,
    unsupportedReason: playable ? null : `This browser cannot decode ${extension || 'this format'}. The file is listed but will not play here.`,
    liked: false,
    explicit: null,
    popularity: null,
  };
  return { track, artwork };
}

/**
 * Index (or re-index) a directory root. Files whose size and modification time are unchanged are
 * left alone, so a rescan of a large library is fast and does not churn `updatedAt` — which would
 * otherwise make every sync think the whole library changed.
 */
export async function scanRoot(db: PlayerDatabase, root: StoredRoot, options: ScanOptions = {}): Promise<ScanResult> {
  if (!root.handle) throw new Error('This folder was added without a persistent handle; pick it again to rescan.');
  const support = options.support ?? probeSupport();
  const result: ScanResult = { rootId: root.id, added: 0, updated: 0, removed: 0, unreadable: [] };
  const progress: ScanProgress = { found: 0, indexed: 0, skipped: 0, currentPath: null };

  const existingFiles = await db.getAllFromIndex('files', 'by-root', root.id);
  const byPath = new Map(existingFiles.map((f) => [f.relativePath, f]));
  const seen = new Set<string>();

  for await (const found of walkDirectory(root.handle)) {
    if (options.signal?.aborted) break;
    progress.found += 1;
    progress.currentPath = found.relativePath;
    seen.add(found.relativePath);

    const previous = byPath.get(found.relativePath);
    if (previous && previous.sizeBytes === found.file.size && previous.lastModified === found.file.lastModified) {
      progress.skipped += 1;
      options.onProgress?.({ ...progress });
      continue;
    }

    try {
      const { track, artwork } = await trackFromFile(found.file, found.relativePath, root.id, support, previous?.trackId);
      const tx = db.transaction(['tracks', 'files', 'artwork'], 'readwrite');
      if (artwork) {
        const artworkId = `art_${track.id}`;
        track.artworkId = artworkId;
        await tx.objectStore('artwork').put({ id: artworkId, blob: artwork.blob, mime: artwork.mime });
      }
      await tx.objectStore('tracks').put(track);
      const ref: StoredFileRef = { trackId: track.id, rootId: root.id, relativePath: found.relativePath, ephemeral: false, sizeBytes: found.file.size, lastModified: found.file.lastModified };
      await tx.objectStore('files').put(ref);
      await tx.done;
      if (previous) result.updated += 1;
      else result.added += 1;
      progress.indexed += 1;
    } catch (err) {
      result.unreadable.push({ path: found.relativePath, reason: err instanceof Error ? err.message : String(err) });
    }
    options.onProgress?.({ ...progress });
  }

  // Files that are gone become tombstones rather than disappearing, so the deletion syncs.
  if (!options.signal?.aborted) {
    for (const [path, ref] of byPath) {
      if (seen.has(path)) continue;
      const track = await db.get('tracks', ref.trackId);
      if (track && !track.deletedAt) {
        await db.put('tracks', { ...track, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        result.removed += 1;
      }
      await db.delete('files', ref.trackId);
    }
  }

  await db.put('roots', { ...root, trackCount: seen.size, lastScanAt: new Date().toISOString(), lastScanError: null });
  return result;
}

/** Index files chosen through a plain `<input type="file">`, which cannot be reopened later. */
export async function indexPickedFiles(db: PlayerDatabase, rootId: string, files: readonly File[], options: ScanOptions = {}): Promise<ScanResult> {
  const support = options.support ?? probeSupport();
  const result: ScanResult = { rootId, added: 0, updated: 0, removed: 0, unreadable: [] };
  const progress: ScanProgress = { found: files.length, indexed: 0, skipped: 0, currentPath: null };
  for (const file of files) {
    if (options.signal?.aborted) break;
    if (!isAudioFile(file.name)) continue;
    progress.currentPath = file.name;
    try {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const { track, artwork } = await trackFromFile(file, relativePath, rootId, support);
      const tx = db.transaction(['tracks', 'files', 'artwork'], 'readwrite');
      if (artwork) {
        const artworkId = `art_${track.id}`;
        track.artworkId = artworkId;
        await tx.objectStore('artwork').put({ id: artworkId, blob: artwork.blob, mime: artwork.mime });
      }
      await tx.objectStore('tracks').put(track);
      await tx.objectStore('files').put({ trackId: track.id, rootId, relativePath, ephemeral: true, sizeBytes: file.size, lastModified: file.lastModified });
      await tx.done;
      result.added += 1;
      progress.indexed += 1;
    } catch (err) {
      result.unreadable.push({ path: file.name, reason: err instanceof Error ? err.message : String(err) });
    }
    options.onProgress?.({ ...progress });
  }
  return result;
}

/** Whether this browser can keep a folder connected across restarts. */
export function supportsDirectoryHandles(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Re-open a track's file. Returns null with a reason the UI can show rather than throwing. */
export async function resolveFile(db: PlayerDatabase, trackId: string): Promise<{ file: File } | { file: null; reason: string }> {
  const ref = await db.get('files', trackId);
  if (!ref) return { file: null, reason: 'This track is not linked to a file on this device.' };
  if (ref.ephemeral) return { file: null, reason: 'This file was added with the file picker, which cannot reopen it after a reload. Add the folder again to keep it available.' };
  const root = await db.get('roots', ref.rootId);
  if (!root?.handle) return { file: null, reason: 'The folder this track came from is no longer connected.' };

  try {
    // Permission can lapse between sessions; the browser re-prompts only on a user gesture, so a
    // refusal here is reported rather than retried.
    const handle = root.handle as FileSystemDirectoryHandle & { queryPermission?: (d: { mode: 'read' }) => Promise<PermissionState>; requestPermission?: (d: { mode: 'read' }) => Promise<PermissionState> };
    const permission = await handle.queryPermission?.({ mode: 'read' });
    if (permission === 'prompt') {
      const granted = await handle.requestPermission?.({ mode: 'read' });
      if (granted !== 'granted') return { file: null, reason: 'Permission to read that folder was not granted.' };
    } else if (permission === 'denied') {
      return { file: null, reason: 'Permission to read that folder was denied. Reconnect it in Settings.' };
    }
    let directory = root.handle;
    const segments = ref.relativePath.split('/');
    const filename = segments.pop()!;
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
    return { file: await (await directory.getFileHandle(filename)).getFile() };
  } catch (err) {
    return { file: null, reason: `That file could not be opened: ${err instanceof Error ? err.message : String(err)}` };
  }
}
