/**
 * The stream names the song itself, in band, and the page can read it.
 *
 * Measured against the Illinois shelf the directory lists: 43 of 109 stations answer
 * `Access-Control-Allow-Origin: *`, expose `icy-metaint` to the page, and carry a real
 * `StreamTitle` in the stream — among them 94.7 WLS (`Mariah Carey - Fantasy`) and Nexus Radio
 * (`Kungs x Boys Noize - Get Away`), which is the first row of the Chicago shelf. Unpaired, that
 * row read "Song not available" for the whole of a watched quarter hour while the bytes naming
 * the song were going past. Nobody had asked the stream.
 *
 * This pins the frame reading itself — `icy-metaint` audio bytes, a length byte in sixteens,
 * then the metadata block — and the refusals that keep the reader cheap: no interval, an
 * oversized interval, a host that will not admit the page, each answered once and not chased.
 */
import { describe, expect, it } from 'vitest';

interface Meta { title: string; artist: string; genre: string; bitrate: number; startedAt: null; duration: null }

/** The shared `StreamTitle` parser from the shell (one rule for in-band ICY and Icecast alike). */
function splitStreamTitle(line: string | null, fallbackArtist: string): { title: string; artist: string } | null {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  const at = s.indexOf(' - ');
  let title = at > 0 ? s.slice(at + 3) : s;
  let artist = at > 0 ? s.slice(0, at) : (fallbackArtist || '');
  title = String(title).replace(/\s*-\s*/g, ' ').trim();
  artist = String(artist).trim();
  if (/^[\s-]*$/.test(title)) title = '';
  if (/^[\s-]*$/.test(artist)) artist = '';
  if (!title && artist) { title = artist; artist = ''; }
  if (!title) return null;
  return { title, artist };
}

/**
 * The shell's `icyDirect` frame reading, over a buffer that is laid out the way a stream is.
 * Returns the same shape the other readers return, so the merge above it cannot tell them apart.
 */
function readIcyFrame(buf: Uint8Array, step: number, headers: { genre?: string; bitrate?: number }): Meta | null {
  const genre = (headers.genre ?? '').trim();
  const bitrate = headers.bitrate ?? 0;
  const bare = (): Meta | null => ((genre || bitrate)
    ? { title: '', artist: '', genre, bitrate, startedAt: null, duration: null } : null);
  if (!step || step > 80_000) return null;
  if (buf.length <= step) return null;
  const len = buf[step]! * 16;
  if (!len || step + 1 + len > buf.length) return bare();
  let stop = step + 1 + len;
  for (let i = step + 1; i < step + 1 + len; i++) { if (!buf[i]) { stop = i; break; } }
  const raw = new TextDecoder('utf-8').decode(buf.subarray(step + 1, stop));
  const m = /StreamTitle='([\s\S]*?)';/.exec(raw) ?? /StreamTitle='([\s\S]*)$/.exec(raw);
  const t = splitStreamTitle(m ? m[1]! : '', '');
  if (!t) return bare();
  return { title: t.title, artist: t.artist, genre, bitrate, startedAt: null, duration: null };
}

/** A stream frame: `step` bytes of audio, a length byte in sixteens, then the padded block. */
function frame(step: number, block: string): Uint8Array {
  const body = new TextEncoder().encode(block);
  const sixteens = Math.ceil(body.length / 16);
  const out = new Uint8Array(step + 1 + sixteens * 16);
  out.fill(0x55, 0, step);                       // audio: anything that is not metadata
  out[step] = sixteens;
  out.set(body, step + 1);
  return out;
}

describe('reading the song out of the stream itself', () => {
  it('names the song and the artist a station is broadcasting', () => {
    // Exactly what stream1.nexusradio.fm/nexusdance.mp3 served, trailing space and all.
    const got = readIcyFrame(frame(4096, "StreamTitle='Kungs x Boys Noize - Get Away ';StreamUrl='';"), 4096,
      { genre: 'Electronic Dance', bitrate: 128 });
    expect(got).toEqual({ title: 'Get Away', artist: 'Kungs x Boys Noize', genre: 'Electronic Dance',
      bitrate: 128, startedAt: null, duration: null });
  });

  it('reads a 16000-byte interval too, which is what most stations use', () => {
    // 94.7 WLS, read live from the directory's shelf.
    const got = readIcyFrame(frame(16_000, "StreamTitle='Mariah Carey - Fantasy';StreamUrl='';"), 16_000, {});
    expect(got?.title).toBe('Fantasy');
    expect(got?.artist).toBe('Mariah Carey');
  });

  it('claims no broadcast position, because in-band metadata carries no cue clock', () => {
    /* The bar belongs to a published cue. This reader has none, so it must not invent one --
       the same rule radio-no-cue pins for the paint path. */
    const got = readIcyFrame(frame(4096, "StreamTitle='Foreigner - I Want to Know What Love Is';"), 4096, {});
    expect(got?.startedAt).toBeNull();
    expect(got?.duration).toBeNull();
  });

  it('keeps a non-ASCII title the way the station spelled it', () => {
    // Plus Radio Nostalgija and its neighbours publish Serbian titles on this shelf.
    const got = readIcyFrame(frame(4096, "StreamTitle='Garavi Sokak - Skeledžija';"), 4096, {});
    expect(got?.title).toBe('Skeledžija');
  });

  it('does not leave a lone dash in the song column when the station sends half a line', () => {
    // CRIS Radio: an artist with the title left blank.
    const got = readIcyFrame(frame(4096, "StreamTitle='Peter Katt -  -  ';"), 4096, {});
    expect(got?.title).toBe('Peter Katt');
    expect(got?.artist).toBe('');
  });

  it('still reports the genre and bitrate when the block names no song', () => {
    /* A zero length byte is the server saying nothing has changed, not a failure: the Genre and
       Kbps columns the directory left empty are still answerable. */
    const got = readIcyFrame(frame(4096, ''), 4096, { genre: 'Classical', bitrate: 256 });
    expect(got).toEqual({ title: '', artist: '', genre: 'Classical', bitrate: 256, startedAt: null, duration: null });
  });

  it('says nothing at all when the station states neither a song nor anything about itself', () => {
    expect(readIcyFrame(frame(4096, ''), 4096, {})).toBeNull();
  });
});

describe('the refusals that keep the reader cheap', () => {
  it('gives up when the stream does not expose its metadata interval', () => {
    /* Without `icy-metaint` visible to the page there is no way to tell audio from metadata,
       and 66 of the 109 stations measured are in exactly that position. */
    expect(readIcyFrame(frame(4096, "StreamTitle='Something - Playing';"), 0, { genre: 'Rock' })).toBeNull();
  });

  it('does not chase a station that buries its metadata past the read budget', () => {
    /* A huge interval would mean pulling the stream itself to find one line of text. */
    expect(readIcyFrame(new Uint8Array(10), 200_000, { genre: 'Rock' })).toBeNull();
  });

  it('does not read past the end of what it actually received', () => {
    const short = frame(4096, "StreamTitle='Truncated - Song';").subarray(0, 4100);
    expect(readIcyFrame(short, 4096, {})).toBeNull();
  });
});
