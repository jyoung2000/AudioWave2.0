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

/* Exactly what iHeart's revma streams sent for 107.5 WGCI and Rock 95.5 (captured live). */
const IHEART_SONG = 'Belly Gang Kushington / 21 Savage - text="Wtf Goin" song_spot="M" MediaBaseId="0" itunesTrackId="0" amgTrackId="-1" amgArtistId="0" TAID="0" TPID="408731045" cartcutId="0447613001" amgArtworkURL="https://i.iheart.com/v3/catalog/track/408731045?ops=fit(200,200),format(%22jpeg%22)" length="00:03:03" unsID="-1" spotInstanceId="-1"';
const IHEART_IMAGING = 'Chicago\'s Rock Station - text="ROCK 95.5" song_spot="T" MediaBaseId="0" itunesTrackId="0" amgTrackId="0" amgArtistId="0" TAID="0" TPID="0" cartcutId="0" amgArtworkURL="" length="00:00:00" unsID="0" spotInstanceId="-1"';
const IHEART_SPOT_END = ' - text="Spot Block End" amgTrackId="9876543" length="00:00:00"';
const IHEART_AD = 'adContext="aHR0cHM6Ly9uMjJiLWUyLnJldm1hLmlocmhscy5jb20vY2FjaGUvdmFzdC8y"';

describe('splitOnAir with iHeart tagged titles', () => {
  it('reads the artist and the quoted song out of a music cue', () => {
    expect(splitOnAir(IHEART_SONG)).toEqual({ artist: 'Belly Gang Kushington / 21 Savage', title: 'Wtf Goin' });
  });
  it('station imaging, the end of an ad break and an ad context are not songs', () => {
    expect(splitOnAir(IHEART_IMAGING)).toBeNull();
    expect(splitOnAir(IHEART_SPOT_END)).toBeNull();
    expect(splitOnAir(IHEART_AD)).toBeNull();
  });
  it('decodes the entities iHeart writes inside a quoted title', () => {
    expect(splitOnAir('Guns N&apos; Roses - text="Don&apos;t Cry" song_spot="M" length="00:04:44"')).toEqual({ artist: "Guns N' Roses", title: "Don't Cry" });
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
