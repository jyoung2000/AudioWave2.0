/**
 * The zip reader is only ever pointed at an archive whose SHA-256 already matched, so its job is not
 * to survive a hostile file for sport — it is to take exactly the two entries asked for, check them,
 * and refuse anything that would write outside the folder even if the archive were somehow wrong.
 * Every archive here is built in the test, so nothing is fetched and nothing is committed.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { bufferSource, crc32, openZip, ZipError } from '../../src/zip.js';

interface Entry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Override the CRC written into the archive, to prove a mismatch is caught. */
  crc?: number;
}

/** A plain PKZIP archive: local headers, central directory, end record. Enough for the reader. */
function buildZip(entries: Entry[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc ?? crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const parts = [...locals, directory];
  if (options.zip64) {
    // A ZIP64 end record and locator, with the classic record's fields saturated as the spec says.
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

describe('reading a zip', () => {
  const ffmpeg = Buffer.from('MZ pretend ffmpeg '.repeat(500));
  const ffprobe = Buffer.from('MZ pretend ffprobe');

  it('lists entries and reads a deflated one and a stored one', () => {
    const zip = openZip(bufferSource(buildZip([{ name: 'ffmpeg-master/bin/ffmpeg.exe', data: ffmpeg }, { name: 'ffmpeg-master/bin/ffprobe.exe', data: ffprobe, method: 0 }, { name: 'ffmpeg-master/LICENSE.txt', data: Buffer.from('GPL') }])));
    expect(zip.entries.map((e) => e.name)).toEqual(['ffmpeg-master/bin/ffmpeg.exe', 'ffmpeg-master/bin/ffprobe.exe', 'ffmpeg-master/LICENSE.txt']);
    expect(zip.read(zip.entries[0]!).equals(ffmpeg)).toBe(true);
    expect(zip.read(zip.entries[1]!).equals(ffprobe)).toBe(true);
  });

  it('follows a ZIP64 end record', () => {
    const zip = openZip(bufferSource(buildZip([{ name: 'top/bin/ffmpeg.exe', data: ffmpeg }], { zip64: true })));
    expect(zip.entries).toHaveLength(1);
    expect(zip.read(zip.entries[0]!).equals(ffmpeg)).toBe(true);
  });

  it('refuses an entry whose CRC-32 does not match what it unpacks to', () => {
    const zip = openZip(bufferSource(buildZip([{ name: 'top/bin/ffmpeg.exe', data: ffmpeg, crc: 1234 }])));
    expect(() => zip.read(zip.entries[0]!)).toThrow(ZipError);
    expect(() => zip.read(zip.entries[0]!)).toThrow(/CRC/);
  });

  it('refuses an archive that names a path outside the folder it unpacks into', () => {
    for (const name of ['../evil.exe', 'top/../../evil.exe', '/etc/evil', '\\windows\\evil.exe', 'C:/Windows/evil.exe', 'c:evil.exe', 'top\\..\\..\\evil.exe']) {
      expect(() => openZip(bufferSource(buildZip([{ name, data: ffprobe }]))), name).toThrow(/unsafe/i);
    }
  });

  it('refuses something that is not a zip at all', () => {
    expect(() => openZip(bufferSource(Buffer.from('not a zip file, just words')))).toThrow(ZipError);
  });

  it('computes the standard CRC-32', () => {
    // The check value every CRC-32 implementation publishes.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});
