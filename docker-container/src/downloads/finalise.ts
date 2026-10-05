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
import { writeFileSync } from 'node:fs';
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
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
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
  const tags = tagMap(input.tags, input.existing, input.sourceUrl);
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
  return { args, output, extension };
}
