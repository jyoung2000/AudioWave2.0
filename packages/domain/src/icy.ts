/**
 * ICY ("SHOUTcast") in-stream metadata — the song titles internet radio stations send.
 *
 * A client that asks with `Icy-MetaData: 1` gets `icy-metaint: N` back, and from then on the stream
 * is N bytes of audio, one length byte (×16), that many bytes of `StreamTitle='…';` text padded with
 * NULs, N bytes of audio, and so on. A page cannot see any of this (the browser consumes the stream
 * and the header needs CORS few stations grant), which is why reading it is the hub's and the
 * companion's job; this file is the pure part both of them share.
 */

/** Splits a raw ICY byte stream into its metadata blocks. Feed it chunks in order. */
export class IcyReader {
  private audioLeft: number;
  private metaLeft = -1;
  private meta: number[] = [];

  constructor(private readonly metaint: number) {
    if (!Number.isInteger(metaint) || metaint <= 0) throw new RangeError('icy-metaint must be a positive integer');
    this.audioLeft = metaint;
  }

  /** Returns the text of every non-empty metadata block completed by this chunk. */
  feed(chunk: Uint8Array): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.audioLeft > 0) {
        const skip = Math.min(this.audioLeft, chunk.length - i);
        this.audioLeft -= skip;
        i += skip;
        continue;
      }
      if (this.metaLeft < 0) {
        this.metaLeft = chunk[i]! * 16;
        this.meta = [];
        i += 1;
      } else {
        const take = Math.min(this.metaLeft, chunk.length - i);
        for (let k = 0; k < take; k++) this.meta.push(chunk[i + k]!);
        this.metaLeft -= take;
        i += take;
      }
      if (this.metaLeft === 0) {
        const text = decodeMeta(Uint8Array.from(this.meta));
        if (text) out.push(text);
      }
      if (this.metaLeft <= 0 && this.metaLeft !== -1) {
        this.metaLeft = -1;
        this.audioLeft = this.metaint;
      }
    }
    return out;
  }
}

/** UTF-8 when the bytes are valid UTF-8, Latin-1 otherwise — what stations actually send. */
function decodeMeta(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  const body = bytes.subarray(0, end);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body).trim();
  } catch {
    return new TextDecoder('latin1').decode(body).trim();
  }
}

/** The `StreamTitle` value of one metadata block, or null when the station sent none. */
export function parseStreamTitle(meta: string): string | null {
  // The value ends at the first `';` — titles are full of apostrophes, the terminator is not.
  const match = /StreamTitle='(.*?)';/s.exec(meta) ?? /StreamTitle='(.*)'\s*$/s.exec(meta);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

/** "Artist - Title" as stations write it; a title with no spaced dash keeps no artist. */
export function splitOnAir(value: string): { artist: string | null; title: string } | null {
  const text = value.trim();
  // A block of dashes or a lone separator is a station between songs, not a song.
  if (!/[\p{L}\p{N}]/u.test(text)) return null;
  const at = text.indexOf(' - ');
  if (at < 0) return text ? { artist: null, title: text } : null;
  const artist = text.slice(0, at).trim();
  const title = text.slice(at + 3).trim();
  if (!title) return artist ? { artist: null, title: artist } : null;
  return { artist: artist || null, title };
}
