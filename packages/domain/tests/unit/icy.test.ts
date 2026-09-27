import { describe, expect, it } from 'vitest';
import { IcyReader, parseStreamTitle, splitOnAir } from '../../src/icy.js';

/** Audio bytes, then one metadata block: a length byte (×16) and the text padded with NULs. */
function block(metaint: number, text: string, fill = 0x41): Uint8Array {
  const body = new TextEncoder().encode(text);
  const len = Math.ceil(body.length / 16);
  const out = new Uint8Array(metaint + 1 + len * 16);
  out.fill(fill, 0, metaint);
  out[metaint] = len;
  out.set(body, metaint + 1);
  return out;
}

describe('parseStreamTitle', () => {
  it('reads the title between the quotes, apostrophes included', () => {
    expect(parseStreamTitle("StreamTitle='Daft Punk - Harder, Better';StreamUrl='';")).toBe('Daft Punk - Harder, Better');
    expect(parseStreamTitle("StreamTitle='Guns N' Roses - Don't Cry';")).toBe("Guns N' Roses - Don't Cry");
  });
  it('an empty or missing title is no title', () => {
    expect(parseStreamTitle("StreamTitle='';")).toBeNull();
    expect(parseStreamTitle("StreamUrl='x';")).toBeNull();
    expect(parseStreamTitle("StreamTitle='   ';")).toBeNull();
  });
});

describe('splitOnAir', () => {
  it('splits "Artist - Title" on the first spaced dash', () => {
    expect(splitOnAir('Daft Punk - Harder - Better')).toEqual({ artist: 'Daft Punk', title: 'Harder - Better' });
  });
  it('keeps a bare title whole, and a station slogan is not a song', () => {
    expect(splitOnAir('Morning Show')).toEqual({ artist: null, title: 'Morning Show' });
    expect(splitOnAir(' - ')).toBeNull();
  });
});

describe('IcyReader', () => {
  it('skips the audio and returns the metadata text, across chunk boundaries', () => {
    const bytes = block(32, "StreamTitle='A - B';");
    const reader = new IcyReader(32);
    const found: string[] = [];
    for (let i = 0; i < bytes.length; i += 7) found.push(...reader.feed(bytes.subarray(i, i + 7)));
    expect(found.map(parseStreamTitle)).toEqual(['A - B']);
  });
  it('an empty block (length 0) yields nothing and reading continues', () => {
    const empty = new Uint8Array(33);
    empty.fill(0x41, 0, 32);
    empty[32] = 0;
    const reader = new IcyReader(32);
    expect(reader.feed(empty)).toEqual([]);
    expect(reader.feed(block(32, "StreamTitle='C - D';")).map(parseStreamTitle)).toEqual(['C - D']);
  });
  it('decodes Latin-1 when the bytes are not UTF-8', () => {
    const bytes = new Uint8Array([...new Uint8Array(4).fill(0x41), 2, ...new TextEncoder().encode("StreamTitle='Beyonc"), 0xe9, 0x27, 0x3b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const reader = new IcyReader(4);
    expect(reader.feed(bytes).map(parseStreamTitle)).toEqual(['Beyoncé']);
  });
});
