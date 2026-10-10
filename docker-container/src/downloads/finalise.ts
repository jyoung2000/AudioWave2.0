/**
 * The last FFmpeg pass over a downloaded file: the tags it should carry, its cover picture, and the
 * format that was asked for — in one run.
 *
 * **Tags come from a file, not the command line.** Every value (a title, an artist, a licence) is
 * written into an FFmpeg metadata file (`;FFMETADATA1`, with its four special characters escaped)
 * that FFmpeg reads as a second input. Nothing a site or a requester supplied is ever an argument,
 * so nothing in it can be read as a flag, and a large cover cannot overrun an argument's length.
 *
 * **What is kept.** What the file already carries (read with music-metadata) is the floor; what the
 * job knows — the cleaned title and artist, featured artists, album, release date — is written over
 * it. The cover the tool embedded is carried across: as an attached picture for MP3, M4A and FLAC,
 * and for Ogg/Opus, where FFmpeg cannot attach a picture stream, as the `METADATA_BLOCK_PICTURE`
 * comment that Opus players read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import type { DownloadJob, DownloadTags } from '@now-playing/contracts';

export const FORMAT_EXTENSIONS: Record<string, string> = { original: '', mp3: '.mp3', aac: '.m4a', opus: '.opus', flac: '.flac' };
export const FORMAT_ARGS: Record<string, string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  aac: ['-c:a', 'aac', '-b:a', '256k'],
  opus: ['-c:a', 'libopus', '-b:a', '160k'],
  flac: ['-c:a', 'flac'],
};

/** Containers whose tags FFmpeg writes, and that the hub therefore rewrites when keeping the original. */
const TAGGABLE = new Set(['.mp3', '.m4a', '.mp4', '.flac', '.opus', '.ogg', '.oga']);
const OGG = new Set(['.opus', '.ogg', '.oga']);

export interface ExistingTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  date: string | null;
  genre: string | null;
  track: number | null;
  disc: number | null;
  picture: { data: Uint8Array; mime: string } | null;
}

/** What the file already says about itself; null when it cannot be read as audio. */
export async function readExisting(path: string): Promise<ExistingTags | null> {
  try {
    const { common } = await parseFile(path, { duration: false, skipPostHeaders: true });
    const picture = common.picture?.find((p) => /^image\/(jpeg|png)$/i.test(p.format)) ?? null;
    return {
      title: common.title ?? null,
      artist: common.artist ?? null,
      album: common.album ?? null,
      albumArtist: common.albumartist ?? null,
      date: common.date ?? (common.year ? String(common.year) : null),
      genre: common.genre?.[0] ?? null,
      track: common.track.no ?? null,
      disc: common.disk.no ?? null,
      picture: picture ? { data: picture.data, mime: picture.format.toLowerCase() } : null,
    };
  } catch {
    return null;
  }
}

/** "Song" with ["A", "B"] featured is "Song (feat. A & B)" — how players show a feature. */
export function titleWithFeatured(tags: DownloadTags): string {
  if (!tags.featured.length) return tags.title;
  const names = tags.featured.length > 1 ? `${tags.featured.slice(0, -1).join(', ')} & ${tags.featured.at(-1)}` : tags.featured[0];
  return `${tags.title} (feat. ${names})`;
}

/** The tags to write: what the file had, under what the job knows. Keys are FFmpeg's generic names. */
export function tagMap(tags: DownloadTags | null | undefined, existing: ExistingTags | null, sourceUrl: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (key: string, value: string | number | null | undefined): void => {
    if (value !== null && value !== undefined && String(value).trim()) out[key] = String(value).trim();
  };
  set('title', existing?.title);
  set('artist', existing?.artist);
  set('album', existing?.album);
  set('album_artist', existing?.albumArtist);
  set('date', existing?.date);
  set('genre', existing?.genre);
  set('track', existing?.track);
  set('disc', existing?.disc);
  if (tags) {
    set('title', titleWithFeatured(tags));
    set('artist', tags.artist);
    set('album', tags.album);
    set('album_artist', tags.albumArtist ?? (tags.album ? tags.artist : null));
    set('date', tags.date);
    set('genre', tags.genre);
    set('track', tags.trackNumber);
    set('disc', tags.discNumber);
    set('copyright', tags.license);
    // Catalog downloads (DEC-039). FFmpeg's generic names: `publisher` is ID3 TPUB and the Vorbis
    // PUBLISHER comment; `lyrics` is M4A ©lyr and the Vorbis LYRICS comment; `isrc` is the Vorbis
    // ISRC comment. MP3 is different (planFinalise): FFmpeg would write both as TXXX frames.
    set('isrc', tags.isrc);
    set('publisher', tags.label);
    set('lyrics', tags.lyrics);
  }
  set('comment', sourceUrl);
  return out;
}

/** `;FFMETADATA1`, with `=`, `;`, `#`, `\` and newlines escaped as the format requires. */
export function ffmetadata(tags: Record<string, string>): string {
  const escape = (value: string): string => value.replace(/[\\=;#\n]/g, (c) => `\\${c}`).replace(/\r/g, '');
  return `;FFMETADATA1\n${Object.entries(tags)
    .map(([key, value]) => `${escape(key)}=${escape(value)}`)
    .join('\n')}\n`;
}

/** A FLAC picture block (front cover), base64 — the form Ogg Vorbis and Opus carry a cover in. */
export function pictureBlock(picture: { data: Uint8Array; mime: string }): string {
  const mime = Buffer.from(picture.mime, 'ascii');
  const description = Buffer.from('Cover (front)', 'utf8');
  const data = Buffer.from(picture.data);
  return Buffer.concat([u32(3), u32(mime.length), mime, u32(description.length), description, u32(0), u32(0), u32(0), u32(0), u32(data.length), data]).toString('base64');
}

/** The extension the finished file gets, or null when the original is kept as it is (a container without tags). */
export function outputExtension(format: DownloadJob['target']['format'], inputExtension: string): string | null {
  if (format !== 'original') return FORMAT_EXTENSIONS[format] ?? null;
  const ext = inputExtension.toLowerCase();
  return TAGGABLE.has(ext) ? ext : null;
}

export interface FinalisePlan {
  args: string[];
  output: string;
  extension: string;
  /** Lyrics for an MP3's USLT frame, written after FFmpeg's pass (`writeId3Lyrics`); FFmpeg cannot. */
  id3Lyrics: string | null;
}

/**
 * The ID3 frames FFmpeg writes for MP3, measured 2026-10-10 (FFmpeg 9.0; its ID3 writer has no
 * USLT support in any release): a generic key it knows becomes its frame (`publisher` → TPUB), a
 * raw frame id it knows is written as that frame (`TSRC`), and anything else — `lyrics` (which it
 * renames USLT) and `isrc` included — becomes a TXXX frame that no player reads as lyrics or ISRC.
 */
function forId3(tags: Record<string, string>): { tags: Record<string, string>; lyrics: string | null } {
  const { lyrics = null, isrc, ...rest } = tags;
  return { tags: isrc ? { ...rest, TSRC: isrc } : rest, lyrics };
}

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

const syncsafe = (n: number): Buffer => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);

/** A TXXX frame's description, to recognise the lyrics FFmpeg filed there ("USLT", "lyrics…"). */
function txxxDescription(body: Buffer): string {
  if (body[0] === 1 || body[0] === 2) {
    for (let i = 1; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i + 1] === 0) return body.subarray(1, i).toString('utf16le').replace(/^﻿/, '');
    return '';
  }
  const end = body.indexOf(0, 1);
  return body.subarray(1, end === -1 ? body.length : end).toString('latin1');
}

/** An ID3v2.3 USLT frame: UTF-16 with a BOM, language "eng", no description. */
export function usltFrame(lyrics: string): Buffer {
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.concat([Buffer.from([1]), Buffer.from('eng', 'latin1'), bom, Buffer.from([0, 0]), bom, Buffer.from(lyrics, 'utf16le')]);
  return Buffer.concat([Buffer.from('USLT', 'latin1'), u32(body.length), Buffer.from([0, 0]), body]);
}

/**
 * The file with `lyrics` in a USLT frame of its ID3v2.3 tag (the version planFinalise asks FFmpeg
 * for), any lyrics or USLT frame already there replaced. Null when the tag is not one this can
 * rewrite safely (another version, unsynchronised, an extended header) — the file is then left as
 * FFmpeg wrote it. A file with no tag gets one.
 */
export function withId3Lyrics(file: Buffer, lyrics: string): Buffer | null {
  const text = lyrics.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  if (file.subarray(0, 3).toString('latin1') !== 'ID3') {
    const frame = usltFrame(text);
    return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(frame.length), frame, file]);
  }
  if (file.length < 10 || file[3] !== 3 || (file[5]! & 0xc0) !== 0) return null;
  const size = ((file[6]! & 0x7f) << 21) | ((file[7]! & 0x7f) << 14) | ((file[8]! & 0x7f) << 7) | (file[9]! & 0x7f);
  const end = 10 + size;
  if (end > file.length) return null;
  const kept: Buffer[] = [];
  let at = 10;
  while (at + 10 <= end && file[at] !== 0) {
    const id = file.subarray(at, at + 4).toString('latin1');
    const length = file.readUInt32BE(at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || at + 10 + length > end) return null;
    const body = file.subarray(at + 10, at + 10 + length);
    const lyricsAlready = id === 'USLT' || (id === 'TXXX' && /^(uslt|lyrics)/i.test(txxxDescription(body)));
    if (!lyricsAlready) kept.push(file.subarray(at, at + 10 + length));
    at += 10 + length;
  }
  const padding = Buffer.alloc(end - at);
  const frames = Buffer.concat([...kept, usltFrame(text), padding]);
  return Buffer.concat([file.subarray(0, 6), syncsafe(frames.length), frames, file.subarray(end)]);
}

/** `withId3Lyrics` on a file in place; false when its tag could not be rewritten. */
export function writeId3Lyrics(path: string, lyrics: string): boolean {
  const next = withId3Lyrics(readFileSync(path), lyrics);
  if (!next) return false;
  writeFileSync(path, next);
  return true;
}

/**
 * Write the metadata file (and the cover, where it travels as a picture stream) into `workDir` and
 * return the FFmpeg command line. Null when there is nothing to do: the original was asked for and
 * the file is in a container FFmpeg does not tag, or there is nothing to tag it with.
 */
export function planFinalise(input: { file: string; inputExtension: string; workDir: string; format: DownloadJob['target']['format']; tags: DownloadTags | null | undefined; existing: ExistingTags | null; sourceUrl: string | null }): FinalisePlan | null {
  const extension = outputExtension(input.format, input.inputExtension);
  if (!extension) return null;
  if (input.format === 'original' && !input.tags) return null;
  const codec = input.format === 'original' ? ['-c:a', 'copy'] : FORMAT_ARGS[input.format];
  if (!codec) return null;
  const ogg = OGG.has(extension);
  const mapped = tagMap(input.tags, input.existing, input.sourceUrl);
  const { tags, lyrics: id3Lyrics } = extension === '.mp3' ? forId3(mapped) : { tags: mapped, lyrics: null };
  const picture = input.existing?.picture ?? null;
  if (ogg && picture) tags['METADATA_BLOCK_PICTURE'] = pictureBlock(picture);
  const metadataFile = join(input.workDir, 'tags.ffmeta');
  writeFileSync(metadataFile, ffmetadata(tags), 'utf8');
  let cover: string | null = null;
  if (!ogg && picture) {
    cover = join(input.workDir, picture.mime === 'image/png' ? 'cover.png' : 'cover.jpg');
    writeFileSync(cover, picture.data);
  }
  const output = join(input.workDir, `final${extension}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input.file, '-f', 'ffmetadata', '-i', metadataFile];
  if (cover) args.push('-i', cover);
  args.push('-map', '0:a:0');
  // "Cover (front)" is what makes ID3 call the picture the front cover rather than "Other".
  if (cover) args.push('-map', '2:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', '-metadata:s:v:0', 'comment=Cover (front)');
  args.push(...codec);
  // Ogg keeps its comments on the audio stream; the other containers keep them on the file.
  if (ogg) args.push('-map_metadata', '-1', '-map_metadata:s:a:0', '1:g');
  else args.push('-map_metadata', '1:g', '-map_metadata:s:a:0', '-1');
  if (extension === '.mp3') args.push('-id3v2_version', '3');
  args.push(output);
  return { args, output, extension, id3Lyrics };
}
