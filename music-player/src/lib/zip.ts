/**
 * Reading a .zip, because that is the shape music actually arrives in.
 *
 * Every platform that will legitimately give you your own music gives it to you as a zip. Bandcamp
 * hands over a purchase that way; Google Takeout hands over the tracks you uploaded to YouTube
 * Music that way; SoundCloud does it when you grab a set of downloadable tracks. Before this, the
 * player made you unzip it yourself first, which on a phone is somewhere between awkward and
 * impossible — and a phone is exactly where a Bandcamp purchase lands.
 *
 * So the player reads the archive itself, with the browser's own inflater and no dependency: the
 * central directory is parsed, audio entries are decompressed one at a time, and each comes out as
 * a `File` that the existing import path cannot tell from one off a disk. Non-audio entries are
 * ignored rather than extracted — a zip is not a folder to be dumped on you, and nothing here ever
 * writes outside the library.
 *
 * What is deliberately not here: any attempt at an encrypted archive. A password on a zip is
 * someone saying who it is for, and guessing at it is not this app's business. Those entries are
 * skipped by name with the reason attached.
 */
import { isAudioFile } from './audio-files.js';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 65535. */
const MAX_EOCD_SCAN = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  lastModified: number;
  encrypted: boolean;
}

export interface ZipReadResult {
  files: File[];
  /** Entries that were not audio, or could not be read, each with the reason. */
  skipped: { name: string; reason: string }[];
}

export function zipSupported(): boolean {
  return typeof DecompressionStream === 'function';
}

/** True for the archives this player offers to open. Nothing else is guessed at from the bytes. */
export function looksLikeZip(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * @param onProgress Called with the number of audio files extracted so far and the number found,
 *   so a fifty-track album does not look frozen.
 */
export async function readZip(file: File, onProgress?: (done: number, total: number) => void): Promise<ZipReadResult> {
  const entries = await listEntries(file);
  const skipped: { name: string; reason: string }[] = [];
  const wanted: ZipEntry[] = [];
  for (const entry of entries) {
    const base = basename(entry.name);
    if (entry.name.endsWith('/')) continue;
    if (entry.name.startsWith('__MACOSX/') || base.startsWith('._') || base.startsWith('.')) continue;
    if (!isAudioFile(base)) {
      skipped.push({ name: entry.name, reason: 'not an audio file' });
      continue;
    }
    if (entry.encrypted) {
      skipped.push({ name: entry.name, reason: 'the archive is password-protected' });
      continue;
    }
    if (entry.compression !== 0 && entry.compression !== 8) {
      skipped.push({ name: entry.name, reason: `compressed with method ${entry.compression}, which browsers cannot read` });
      continue;
    }
    wanted.push(entry);
  }

  const files: File[] = [];
  for (const entry of wanted) {
    onProgress?.(files.length, wanted.length);
    try {
      files.push(await extract(file, entry));
    } catch (error) {
      skipped.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  onProgress?.(files.length, wanted.length);
  return { files, skipped };
}

/** The central directory, which is the only trustworthy listing — local headers may lie about size. */
export async function listEntries(file: File): Promise<ZipEntry[]> {
  const tailLength = Math.min(file.size, MAX_EOCD_SCAN);
  const tail = new DataView(await file.slice(file.size - tailLength, file.size).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
    if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('That does not look like a .zip file — no end-of-archive record was found.');

  let count = tail.getUint16(eocd + 10, true);
  let directoryOffset = tail.getUint32(eocd + 16, true);
  let directorySize = tail.getUint32(eocd + 12, true);

  // Zip64: the 32-bit fields are pinned at their maximum and the real ones live in a second record.
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error('This archive is larger than a plain .zip can describe and its 64-bit record is missing.');
    }
    const zip64At = Number(tail.getBigUint64(locator + 8, true));
    const record = new DataView(await file.slice(zip64At, zip64At + 56).arrayBuffer());
    if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) throw new Error('This archive’s 64-bit end record is damaged.');
    count = Number(record.getBigUint64(32, true));
    directorySize = Number(record.getBigUint64(40, true));
    directoryOffset = Number(record.getBigUint64(48, true));
  }

  const directory = new DataView(await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count && at + 46 <= directory.byteLength; i += 1) {
    if (directory.getUint32(at, true) !== CENTRAL_SIGNATURE) break;
    const flags = directory.getUint16(at + 8, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    const name = decodeName(new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength), (flags & 0x0800) !== 0);
    const entry: ZipEntry = {
      name,
      compression: directory.getUint16(at + 10, true),
      compressedSize: directory.getUint32(at + 20, true),
      uncompressedSize: directory.getUint32(at + 24, true),
      localHeaderOffset: directory.getUint32(at + 42, true),
      lastModified: dosDate(directory.getUint16(at + 14, true), directory.getUint16(at + 12, true)),
      encrypted: (flags & 0x0001) !== 0,
    };
    applyZip64Extra(entry, new DataView(directory.buffer, directory.byteOffset + at + 46 + nameLength, extraLength));
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * The central directory gives the local header's position, not the data's: only the local header
 * knows how long its own name and extra field are, so it has to be read before the bytes can be cut.
 */
async function extract(file: File, entry: ZipEntry): Promise<File> {
  const header = new DataView(await file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) throw new Error('its header is damaged');
  const start = entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const slice = file.slice(start, start + entry.compressedSize);
  const name = basename(entry.name);
  if (entry.compression === 0) return new File([slice], name, { lastModified: entry.lastModified });
  const inflated = await new Response(slice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  return new File([inflated], name, { lastModified: entry.lastModified });
}

function applyZip64Extra(entry: ZipEntry, extra: DataView): void {
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const id = extra.getUint16(at, true);
    const size = extra.getUint16(at + 2, true);
    if (id === 0x0001) {
      // Only the fields that were pinned at 0xFFFFFFFF are present, in this order.
      let field = at + 4;
      if (entry.uncompressedSize === 0xffffffff && field + 8 <= extra.byteLength) {
        entry.uncompressedSize = Number(extra.getBigUint64(field, true));
        field += 8;
      }
      if (entry.compressedSize === 0xffffffff && field + 8 <= extra.byteLength) {
        entry.compressedSize = Number(extra.getBigUint64(field, true));
        field += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff && field + 8 <= extra.byteLength) {
        entry.localHeaderOffset = Number(extra.getBigUint64(field, true));
      }
      return;
    }
    at += 4 + size;
  }
}

/** Bit 11 of the flags promises UTF-8; without it a name is CP437, for which 1252 is the near miss. */
function decodeName(bytes: Uint8Array, utf8: boolean): string {
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/**
 * MS-DOS packed date and time, in local time, which is all a zip records. Some writers leave the
 * month or day at zero when they do not know it, and `new Date(y, -1, 0)` quietly walks back into
 * the previous year — so both are clamped rather than trusted.
 */
function dosDate(date: number, time: number): number {
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = Math.min(Math.max((date >> 5) & 0x0f, 1), 12) - 1;
  const day = Math.min(Math.max(date & 0x1f, 1), 31);
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  const at = new Date(year, month, day, hours, minutes, seconds).getTime();
  return Number.isFinite(at) ? at : Date.now();
}

export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}
