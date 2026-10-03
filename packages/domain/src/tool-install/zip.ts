/**
 * Just enough of a zip reader to take ffmpeg.exe and ffprobe.exe out of the FFmpeg build archive.
 *
 * Node has inflate but no zip, and a dependency for forty lines of header parsing would be a
 * dependency everyone who reads this helper has to trust. So: the end record (and its ZIP64 form),
 * the central directory, stored and deflated entries, a CRC-32 check on every entry read, and
 * nothing else — no encryption, no multi-disk archives, no writing.
 *
 * It is only ever pointed at an archive whose SHA-256 already matched the one its publisher
 * released, but it still refuses any entry name that could land outside the folder it is unpacked
 * into (`..`, an absolute path, a drive letter). Those names have no business in a build archive,
 * and a reader that tolerated them would be one careless caller away from writing anywhere.
 *
 * Reads go through a `ZipSource` so the 200 MB archive can stay on disk: only the directory and the
 * two entries asked for are ever in memory.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipSource {
  size: number;
  read: (offset: number, length: number) => Buffer;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  /** The entry's bytes, inflated and CRC-checked. Throws ZipError otherwise. */
  read: (entry: ZipEntry) => Buffer;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The largest entry this will inflate. ffmpeg.exe is about 150 MB; this leaves room and no more. */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

export function bufferSource(buffer: Buffer): ZipSource {
  return {
    size: buffer.length,
    read: (offset, length) => {
      if (offset < 0 || offset + length > buffer.length) throw new ZipError('The archive is truncated.');
      return buffer.subarray(offset, offset + length);
    },
  };
}

/** Open a zip on disk, hand it to `use`, and close it again whatever happens. */
export function withZipFile<T>(path: string, use: (zip: ZipArchive) => T): T {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const source: ZipSource = {
      size,
      read: (offset, length) => {
        if (offset < 0 || offset + length > size) throw new ZipError('The archive is truncated.');
        const buffer = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
          const n = readSync(fd, buffer, done, length - done, offset + done);
          if (n === 0) throw new ZipError('The archive is truncated.');
          done += n;
        }
        return buffer;
      },
    };
    return use(openZip(source));
  } finally {
    closeSync(fd);
  }
}

export function openZip(source: ZipSource): ZipArchive {
  const end = findEnd(source);
  let count = end.readUInt16LE(10);
  let directorySize = end.readUInt32LE(12);
  let directoryOffset = end.readUInt32LE(16);

  // A saturated field means the real value is in the ZIP64 end record, found through its locator.
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const eocdAt = locateEnd(source);
    if (eocdAt < 20) throw new ZipError('The archive says it is ZIP64 but has no ZIP64 locator.');
    const locator = source.read(eocdAt - 20, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw new ZipError('The archive says it is ZIP64 but has no ZIP64 locator.');
    const recordAt = toNumber(locator.readBigUInt64LE(8));
    const record = source.read(recordAt, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipError('The ZIP64 end record is missing.');
    count = toNumber(record.readBigUInt64LE(32));
    directorySize = toNumber(record.readBigUInt64LE(40));
    directoryOffset = toNumber(record.readBigUInt64LE(48));
  }

  const directory = source.read(directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw new ZipError('The central directory is damaged.');
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    let compressedSize = directory.readUInt32LE(at + 20);
    let uncompressedSize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    let localHeaderOffset = directory.readUInt32LE(at + 42);
    const name = directory.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const extra = directory.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);

    // ZIP64 extra field (0x0001): only the saturated values are present, in this order.
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const size = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let p = e + 4;
        const next = (): number => {
          if (p + 8 > e + 4 + size) throw new ZipError('A ZIP64 field is short.');
          const value = toNumber(extra.readBigUInt64LE(p));
          p += 8;
          return value;
        };
        if (uncompressedSize === 0xffffffff) uncompressedSize = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = next();
      }
      e += 4 + size;
    }

    if (!safeEntryName(name)) throw new ZipError(`The archive holds an unsafe entry name (${JSON.stringify(name.slice(0, 80))}), so none of it was used.`);
    entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, read: (entry) => readEntry(source, entry) };
}

function readEntry(source: ZipSource, entry: ZipEntry): Buffer {
  if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted.`);
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new ZipError(`${entry.name} is larger than anything this reader will unpack.`);
  const header = source.read(entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL) throw new ZipError(`The local header for ${entry.name} is missing.`);
  const dataAt = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = source.read(dataAt, entry.compressedSize);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
    } catch (error) {
      throw new ZipError(`${entry.name} could not be inflated: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else throw new ZipError(`${entry.name} uses compression method ${entry.method}, which this reader does not handle.`);
  if (data.length !== entry.uncompressedSize) throw new ZipError(`${entry.name} unpacked to the wrong size.`);
  if (crc32(data) !== entry.crc32 >>> 0) throw new ZipError(`${entry.name} failed its CRC-32 check.`);
  return data;
}

/** Relative, no parent steps, no drive, no NUL — in either slash. */
export function safeEntryName(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  if (name.startsWith('/') || name.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((segment) => segment === '..');
}

function findEnd(source: ZipSource): Buffer {
  return source.read(locateEnd(source), 22);
}

/** The end record is the last 22 bytes plus a comment of up to 64 KB, so search back that far. */
function locateEnd(source: ZipSource): number {
  if (source.size < 22) throw new ZipError('This is not a zip archive.');
  const span = Math.min(source.size, 22 + 0xffff);
  const tail = source.read(source.size - span, span);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === EOCD) return source.size - span + i;
  }
  throw new ZipError('This is not a zip archive.');
}

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('A size in the archive is out of range.');
  return Number(value);
}

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
