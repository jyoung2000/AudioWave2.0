/**
 * The FFmpeg pass that tags a downloaded file and carries its cover across.
 *
 * Values never reach FFmpeg's command line: a title written to look like flags lands in the
 * metadata file, escaped, and the arguments are the same whatever the title says. The cover goes
 * in as an attached picture where the container can hold one, and as METADATA_BLOCK_PICTURE in Ogg.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadTags } from '@now-playing/contracts';
import { ffmetadata, outputExtension, pictureBlock, planFinalise, tagMap, titleWithFeatured, type ExistingTags } from '../../src/downloads/finalise.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'np-finalise-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tags = (patch: Partial<DownloadTags> = {}): DownloadTags => ({ title: 'Big Buck Bunny', artist: 'Blender', featured: [], album: null, albumArtist: null, date: '2014-11-10', genre: null, trackNumber: null, discNumber: null, durationMs: 635_000, artworkUrl: null, license: 'Creative Commons Attribution license (reuse allowed)', ...patch });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const existing = (patch: Partial<ExistingTags> = {}): ExistingTags => ({ title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', artist: 'Blender', album: null, albumArtist: null, date: '20141110', genre: 'Film & Animation', track: null, disc: null, picture: { data: JPEG, mime: 'image/jpeg' }, ...patch });

describe('the tags written', () => {
  it('the job’s clean tags over what the file carried, the source as the comment', () => {
    const map = tagMap(tags(), existing(), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    expect(map).toMatchObject({ title: 'Big Buck Bunny', artist: 'Blender', date: '2014-11-10', genre: 'Film & Animation', copyright: 'Creative Commons Attribution license (reuse allowed)', comment: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
  });

  it('featured artists in the title, as players show them', () => {
    expect(titleWithFeatured(tags({ title: 'Song', featured: ['A'] }))).toBe('Song (feat. A)');
    expect(titleWithFeatured(tags({ title: 'Song', featured: ['A', 'B', 'C'] }))).toBe('Song (feat. A, B & C)');
  });

  it('escapes the metadata format’s special characters, so a value cannot start a new key', () => {
    const text = ffmetadata({ title: 'a=b;c#d\\e\nartist=Mallory' });
    expect(text).toBe(';FFMETADATA1\ntitle=a\\=b\\;c\\#d\\\\e\\\nartist\\=Mallory\n');
  });

  it('a cover as a FLAC picture block: front cover, its type, its bytes', () => {
    const block = Buffer.from(pictureBlock({ data: JPEG, mime: 'image/jpeg' }), 'base64');
    expect(block.readUInt32BE(0)).toBe(3);
    expect(block.subarray(8, 18).toString()).toBe('image/jpeg');
    expect(block.subarray(block.length - JPEG.length)).toEqual(Buffer.from(JPEG));
  });
});

describe('the FFmpeg command line', () => {
  const hostile = tags({ title: '-i /etc/passwd -f null', artist: '-y' });

  it('keeps every value off the command line, whatever it says', () => {
    const plan = planFinalise({ file: join(dir, 'media.mp3'), inputExtension: '.mp3', workDir: dir, format: 'original', tags: hostile, existing: existing(), sourceUrl: null })!;
    expect(plan.args.join(' ')).not.toContain('/etc/passwd');
    expect(plan.args).not.toContain('-y -y');
    const written = readFileSync(join(dir, 'tags.ffmeta'), 'utf8');
    expect(written).toContain('title=-i /etc/passwd -f null');
    expect(written).toContain('artist=-y');
  });

  it('MP3: re-tags without re-encoding, with the cover as an attached picture', () => {
    const plan = planFinalise({ file: join(dir, 'media.mp3'), inputExtension: '.mp3', workDir: dir, format: 'original', tags: tags(), existing: existing(), sourceUrl: null })!;
    expect(plan.extension).toBe('.mp3');
    expect(plan.args).toEqual(expect.arrayContaining(['-c:a', 'copy', '-disposition:v:0', 'attached_pic', '-id3v2_version', '3']));
    expect(plan.args.slice(plan.args.indexOf('-map'), plan.args.indexOf('-map') + 4)).toEqual(['-map', '0:a:0', '-map', '2:v:0']);
    expect(readFileSync(join(dir, 'cover.jpg'))).toEqual(Buffer.from(JPEG));
  });

  it('Opus: no picture stream (Ogg cannot hold one) — the cover travels as METADATA_BLOCK_PICTURE', () => {
    const plan = planFinalise({ file: join(dir, 'media.opus'), inputExtension: '.opus', workDir: dir, format: 'original', tags: tags(), existing: existing(), sourceUrl: null })!;
    expect(plan.extension).toBe('.opus');
    expect(plan.args).not.toContain('attached_pic');
    expect(plan.args).toEqual(expect.arrayContaining(['-map_metadata:s:a:0', '1:g']));
    expect(readFileSync(join(dir, 'tags.ffmeta'), 'utf8')).toMatch(/^METADATA_BLOCK_PICTURE=[A-Za-z0-9+/]+(\\=)*$/m);
  });

  it('converting keeps tags and cover too: Opus to MP3, AAC (M4A) and FLAC', () => {
    for (const [format, extension, codec] of [
      ['mp3', '.mp3', 'libmp3lame'],
      ['aac', '.m4a', 'aac'],
      ['flac', '.flac', 'flac'],
    ] as const) {
      const plan = planFinalise({ file: join(dir, 'media.opus'), inputExtension: '.opus', workDir: dir, format, tags: tags(), existing: existing(), sourceUrl: null })!;
      expect(plan.extension).toBe(extension);
      expect(plan.args).toEqual(expect.arrayContaining(['-c:a', codec, '-disposition:v:0', 'attached_pic', '-map_metadata', '1:g']));
    }
  });

  it('a file’s own tags are kept when converting even with nothing new to add', () => {
    const plan = planFinalise({ file: join(dir, 'song.flac'), inputExtension: '.flac', workDir: dir, format: 'mp3', tags: null, existing: existing({ title: 'Mine', artist: 'Me' }), sourceUrl: null })!;
    expect(plan).not.toBeNull();
    expect(readFileSync(join(dir, 'tags.ffmeta'), 'utf8')).toContain('title=Mine');
  });

  it('nothing to do: the original asked for with nothing to tag, or a container FFmpeg does not tag', () => {
    expect(planFinalise({ file: join(dir, 'a.mp3'), inputExtension: '.mp3', workDir: dir, format: 'original', tags: null, existing: existing(), sourceUrl: null })).toBeNull();
    expect(planFinalise({ file: join(dir, 'a.webm'), inputExtension: '.webm', workDir: dir, format: 'original', tags: tags(), existing: null, sourceUrl: null })).toBeNull();
    expect(outputExtension('original', '.M4A')).toBe('.m4a');
    expect(outputExtension('aac', '.opus')).toBe('.m4a');
  });
});
