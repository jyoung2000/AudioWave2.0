/**
 * Copies of chosen files, kept inside the app.
 *
 * A folder the browser can reopen is the best case, and desktop Chrome and Edge offer it. Phones do
 * not: on Android and iOS a file picker hands over a File that is gone after a reload. For those,
 * the player can keep its own copy in the origin-private file system — storage that belongs to this
 * app alone, is never uploaded, counts against the site's quota, and survives reloads and
 * reinstalls of the home-screen icon. It is what turns "choose files" into an offline library.
 *
 * Writing uses a writable stream where the browser has one, and a worker with a synchronous access
 * handle where it does not (Safari before 26). Reading is the same everywhere.
 */
import CopyWriter from '../workers/copy-writer.ts?worker&inline';

const DIRECTORY = 'copies';

let supportCheck: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;

/** Whether this browser, at this origin, can keep copies. Probed once and remembered. */
export function copiesSupported(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!supportCheck) {
    supportCheck = (async () => {
      if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
        return { ok: false as const, reason: 'This browser has no private storage for the app to keep copies in.' };
      }
      if (typeof location !== 'undefined' && location.protocol === 'file:') {
        return { ok: false as const, reason: 'A page opened from a file has no private storage of its own, so copies cannot be kept. Use the served player for that.' };
      }
      try {
        await navigator.storage.getDirectory();
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, reason: `This browser refused private storage for the app: ${error instanceof Error ? error.message : String(error)}` };
      }
    })();
  }
  return supportCheck;
}

async function copiesDirectory(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIRECTORY, { create });
  } catch {
    return null;
  }
}

/** Copy `file` into private storage under `objectId`. Throws with a readable reason when it cannot. */
export async function keepCopy(objectId: string, file: File): Promise<void> {
  const directory = await copiesDirectory(true);
  if (!directory) throw new Error('Private storage is not available here.');
  const handle = await directory.getFileHandle(objectId, { create: true });
  const withStream = handle as FileSystemFileHandle & { createWritable?: () => Promise<WritableStream<BufferSource | Blob | string>> };
  if (typeof withStream.createWritable === 'function') {
    const writable = await withStream.createWritable();
    await file.stream().pipeTo(writable);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const worker = new CopyWriter();
    worker.onmessage = (event: MessageEvent<{ ok: boolean; reason?: string }>) => {
      worker.terminate();
      if (event.data.ok) resolve();
      else reject(new Error(event.data.reason ?? 'The copy could not be written.'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The copy could not be written.'));
    };
    worker.postMessage({ objectId, file });
  });
}

/** The copy kept under `objectId`, as a File, or null when it is not there any more. */
export async function readCopy(objectId: string, name?: string): Promise<File | null> {
  const directory = await copiesDirectory(false);
  if (!directory) return null;
  try {
    const file = await (await directory.getFileHandle(objectId)).getFile();
    return name ? new File([file], name, { type: file.type, lastModified: file.lastModified }) : file;
  } catch {
    return null;
  }
}

export async function removeCopy(objectId: string): Promise<void> {
  const directory = await copiesDirectory(false);
  if (!directory) return;
  try {
    await directory.removeEntry(objectId);
  } catch {
    // Already gone, which is the state we wanted.
  }
}

/** How many copies are kept and how much they take, or null when the browser cannot say. */
export async function copiesReport(): Promise<{ count: number; bytes: number } | null> {
  const support = await copiesSupported();
  if (!support.ok) return null;
  const directory = await copiesDirectory(false);
  if (!directory) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  try {
    for await (const handle of (directory as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) {
      if (handle.kind !== 'file') continue;
      count += 1;
      bytes += (await (handle as FileSystemFileHandle).getFile()).size;
    }
  } catch {
    return null;
  }
  return { count, bytes };
}

/**
 * Ask the browser not to clear this site's data under storage pressure. Chrome grants it silently
 * to installed apps and to sites you use often; Firefox asks; Safari decides on its own. Null when
 * the browser offers no such promise at all.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storagePersisted(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
