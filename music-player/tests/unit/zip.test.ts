/**
 * Unpacking the archive a platform hands you.
 *
 * The archives that matter here are real ones: a Bandcamp purchase (deflated, UTF-8 names, a folder
 * per album, a cover and a text file alongside the audio) and a Google Takeout (the same shape with
 * deeper paths). So the fixtures are built the way those are built rather than the way a minimal
 * test zip would be, and the assertions are about what comes out the other end: the audio, with its
 * own name, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { listEntries, looksLikeZip, readZip, zipSupported } from '../../src/lib/zip.js';

interface Member {
  name: string;
  body: Uint8Array;
  /** 0 stored, 8 deflate. */
  method: 0 | 8;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A zip writer, only as complete as the reader needs: local headers, a central directory and an end
 * record. CRCs are left at zero — the reader does not check them, and a wrong one here would be a
 * test of the fixture rather than of the code.
 */
async function buildZip(members: readonly Member[], { comment = '' } = {}): Promise<File> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = text(member.name);
    const payload = member.method === 8 ? await deflate(member.body) : member.body;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, member.method, true);
    local.setUint16(10, 0x9d40, true); // 19:42:00
    local.setUint16(12, 0x5a21, true); // 2025-01-01
    local.setUint32(14, 0, true);
    local.setUint32(18, payload.length, true);
    local.setUint32(22, member.body.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, payload);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, member.method, true);
    entry.setUint16(12, 0x9d40, true);
    entry.setUint16(14, 0x5a21, true);
    entry.setUint32(16, 0, true);
    entry.setUint32(20, payload.length, true);
    entry.setUint32(24, member.body.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + payload.length;
  }

  const directory = central.reduce((total, part) => total + part.length, 0);
  const tail = text(comment);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, members.length, true);
  end.setUint16(10, members.length, true);
  end.setUint32(12, directory, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, tail.length, true);
  return new File([...parts, ...central, new Uint8Array(end.buffer), tail].map((part) => part as BufferSource), 'album.zip', { type: 'application/zip' });
}

const FLAC = text('fLaC fake stream');
const COVER = text('\x89PNG not really');

describe('reading a .zip', () => {
  it('is supported in this runtime, so the player can offer it', () => {
    expect(zipSupported()).toBe(true);
  });

  it('recognises an archive by name or type, and nothing else by guesswork', () => {
    expect(looksLikeZip(new File([], 'Purchase.ZIP'))).toBe(true);
    expect(looksLikeZip(new File([], 'album', { type: 'application/zip' }))).toBe(true);
    expect(looksLikeZip(new File([], 'song.flac', { type: 'audio/flac' }))).toBe(false);
  });

  it('takes the audio out of a purchase and leaves everything else in', async () => {
    const zip = await buildZip([
      { name: 'Artist - Album/01 First Song.flac', body: FLAC, method: 8 },
      { name: 'Artist - Album/02 Second Song.flac', body: FLAC, method: 8 },
      { name: 'Artist - Album/cover.png', body: COVER, method: 8 },
      { name: 'Artist - Album/about.txt', body: text('thank you for buying'), method: 0 },
    ]);

    const result = await readZip(zip);
    expect(result.files.map((file) => file.name)).toEqual(['01 First Song.flac', '02 Second Song.flac']);
    // Everything else is reported rather than silently dropped — and never written anywhere.
    expect(result.skipped).toEqual([
      { name: 'Artist - Album/cover.png', reason: 'not an audio file' },
      { name: 'Artist - Album/about.txt', reason: 'not an audio file' },
    ]);
    expect(await result.files[0]!.text()).toBe('fLaC fake stream');
  });

  it('reads stored entries as well as deflated ones', async () => {
    const zip = await buildZip([{ name: 'Takeout/YouTube and YouTube Music/music-uploads/Upload.mp3', body: text('ID3 fake'), method: 0 }]);
    const result = await readZip(zip);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe('Upload.mp3');
    expect(await result.files[0]!.text()).toBe('ID3 fake');
  });

  it('ignores the resource forks a Mac puts in an archive', async () => {
    const zip = await buildZip([
      { name: '__MACOSX/._01 First Song.flac', body: text('junk'), method: 0 },
      { name: 'Album/._02 Second Song.flac', body: text('junk'), method: 0 },
      { name: 'Album/02 Second Song.flac', body: FLAC, method: 8 },
    ]);
    const result = await readZip(zip);
    expect(result.files.map((file) => file.name)).toEqual(['02 Second Song.flac']);
  });

  it('finds the end record behind an archive comment', async () => {
    const zip = await buildZip([{ name: 'One.flac', body: FLAC, method: 8 }], { comment: 'downloaded from a shop — '.repeat(40) });
    expect((await listEntries(zip)).map((entry) => entry.name)).toEqual(['One.flac']);
  });

  it('gives each track the date the archive recorded', async () => {
    const [entry] = await listEntries(await buildZip([{ name: 'One.flac', body: FLAC, method: 8 }]));
    expect(new Date(entry!.lastModified).getFullYear()).toBe(2025);
  });

  it('reports a file that is not an archive rather than throwing something cryptic', async () => {
    await expect(readZip(new File([text('this is a song, not a zip') as BufferSource], 'song.zip'))).rejects.toThrow(/does not look like a \.zip/);
  });

  it('carries on past an entry it cannot read, and says which', async () => {
    const zip = await buildZip([
      { name: 'Good.flac', body: FLAC, method: 8 },
      { name: 'Locked.flac', body: FLAC, method: 8 },
    ]);
    // Flip the encryption bit in the second central-directory record, as a password would.
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let at = 0;
    const found: number[] = [];
    while (at < bytes.length - 4) {
      if (view.getUint32(at, true) === 0x02014b50) found.push(at);
      at += 1;
    }
    view.setUint16(found[1]! + 8, 0x0801, true);

    const result = await readZip(new File([bytes as BufferSource], 'album.zip'));
    expect(result.files.map((file) => file.name)).toEqual(['Good.flac']);
    expect(result.skipped).toEqual([{ name: 'Locked.flac', reason: 'the archive is password-protected' }]);
  });

  it('reports progress so a fifty-track album does not look frozen', async () => {
    const zip = await buildZip([
      { name: 'One.flac', body: FLAC, method: 8 },
      { name: 'Two.flac', body: FLAC, method: 8 },
      { name: 'notes.txt', body: text('hello'), method: 0 },
    ]);
    const seen: Array<[number, number]> = [];
    await readZip(zip, (done, total) => seen.push([done, total]));
    // Totals count only what will be extracted, so the bar does not stall on the text file.
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });
});
