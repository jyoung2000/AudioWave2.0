/**
 * Where downloads go.
 *
 * By default a browser drops a download wherever it drops everything else,
 * which is fine for a spreadsheet and wrong for music: a library lives in a
 * particular folder, and having to move every track out of Downloads by hand
 * is the kind of small tax that stops people using a feature at all.
 *
 * So the player can be given a folder once and write into it from then on.
 * That is the same File System Access permission the music folders already
 * use, asked for with write access this time, and the handle is kept in the
 * same database — so the choice survives a restart without the player ever
 * knowing the path. A folder handle is an opaque capability; it carries no
 * directory name anyone could log, and `docs/PRIVACY.md`'s rule that
 * filesystem paths never leave the owning device holds unchanged.
 *
 * Where the browser has no directory picker — Firefox, Safari, every phone —
 * there is nothing to choose, and the setting says so instead of offering a
 * control that cannot work.
 */

/** Where a saved file should land. */
export type DownloadDestination =
  | { kind: 'folder'; handle: FileSystemDirectoryHandle; name: string }
  /** Ask with the system save dialog, every time. */
  | { kind: 'ask' }
  /** Hand it to the browser, which puts it wherever downloads go. */
  | { kind: 'browser' };

interface PermissionCapable {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
}

type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;

/** Whether this browser can be given a folder at all. */
export function supportsDownloadFolder(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Whether it can at least ask where to put each file. */
export function supportsSavePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

/**
 * Ask for a folder. Null when the person closed the picker, which is not an
 * error and is not worth reporting back to them as one.
 */
export async function pickDownloadFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot hand a folder to a web app.');
  try {
    // `id` asks the browser to reopen where this app was last pointed, rather
    // than at the top of the disk each time.
    return await picker.call(window, { id: 'now-playing-downloads', mode: 'readwrite' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/**
 * Is the folder still ours to write to?
 *
 * Permission lapses between sessions and browsers only re-prompt inside a
 * user gesture, so this is called from the click that starts a download, and
 * a refusal is reported rather than retried.
 */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<{ ok: true } | { ok: false; reason: string }> {
  const capable = handle as FileSystemDirectoryHandle & PermissionCapable;
  try {
    const state = await capable.queryPermission?.({ mode: 'readwrite' });
    if (state === 'granted') return { ok: true };
    if (state === 'denied') {
      return { ok: false, reason: `Permission to write to “${handle.name}” was denied. Choose the folder again in Settings.` };
    }
    const granted = await capable.requestPermission?.({ mode: 'readwrite' });
    if (granted === 'granted') return { ok: true };
    return { ok: false, reason: `Permission to write to “${handle.name}” was not granted, so nothing was saved.` };
  } catch (error) {
    return { ok: false, reason: `That folder could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Anything a filesystem dislikes, out of a folder name. */
export function safeSegment(text: string): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing dot or space is legal on one platform and not on another.
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 120) || 'Unknown';
}

/**
 * A name that is not already taken.
 *
 * Overwriting whatever happens to share the name would be the easy
 * implementation and an unkind one: the file in the way is the listener's,
 * not ours, and they never asked us to replace it.
 */
export async function freeName(directory: FileSystemDirectoryHandle, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const extension = dot === -1 ? '' : filename.slice(dot);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? filename : `${stem} (${n})${extension}`;
    try {
      await directory.getFileHandle(candidate);
      // It opened, so something is there. Try the next number.
    } catch {
      // Nothing of that name: it is free.
      return candidate;
    }
  }
  return `${stem} (${Date.now()})${extension}`;
}

export interface WriteOptions {
  /** Put the file under Artist/Album rather than loose in the folder. */
  organise?: boolean;
  artistName?: string;
  albumName?: string | null;
}

/**
 * Write a file into a chosen folder, and say where it went.
 *
 * The returned path is relative and made of names the listener chose or that
 * came from their own tags; it is not a filesystem path and there is no way
 * to obtain one from here.
 */
export async function writeIntoFolder(handle: FileSystemDirectoryHandle, filename: string, blob: Blob, options: WriteOptions = {}): Promise<{ path: string }> {
  let directory = handle;
  const parts: string[] = [handle.name];
  if (options.organise) {
    const segments = [safeSegment(options.artistName ?? 'Unknown Artist'), safeSegment(options.albumName ?? 'Unknown Album')];
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
      parts.push(segment);
    }
  }
  const name = await freeName(directory, filename);
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await (file as FileSystemFileHandle & { createWritable(): Promise<WritableStream<BlobPart>> }).createWritable();
  await blob.stream().pipeTo(writable);
  parts.push(name);
  return { path: parts.join('/') };
}

/** What the setting should say when nothing has been chosen. */
export function defaultDestination(): DownloadDestination {
  if (supportsSavePicker()) return { kind: 'ask' };
  return { kind: 'browser' };
}

/** One line describing where files will go, for the settings panel. */
export function describeDestination(destination: DownloadDestination): string {
  switch (destination.kind) {
    case 'folder':
      return `Saved straight into “${destination.name}”.`;
    case 'ask':
      return 'You are asked where to put each file.';
    default:
      return 'Handed to the browser, which puts it wherever your downloads go.';
  }
}
