/**
 * The FFmpeg pass that tags a downloaded file and carries its cover across.
 *
 * Values never reach FFmpeg's command line: a title written to look like flags lands in the
 * metadata file, escaped, and the arguments are the same whatever the title says. The cover goes
 * in as an attached picture where the container can hold one, and as METADATA_BLOCK_PICTURE in Ogg.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFile } from 'music-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadTags } from '@now-playing/contracts';
import { ffmetadata, outputExtension, pictureBlock, planFinalise, tagMap, titleWithFeatured, usltFrame, withId3Lyrics, writeId3Lyrics, type ExistingTags } from '../../src/downloads/finalise.js';

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

  it('a catalog download’s ISRC, label and lyrics, under FFmpeg’s generic names, lyrics lines intact (DEC-039)', () => {
    const map = tagMap(tags({ isrc: 'USQX91300108', label: 'Columbia', lyrics: '[00:01.00] One\n[00:02.00] Two' }), null, null);
    expect(map).toMatchObject({ isrc: 'USQX91300108', publisher: 'Columbia', lyrics: '[00:01.00] One\n[00:02.00] Two' });
    expect(ffmetadata({ lyrics: map['lyrics']! })).toBe(';FFMETADATA1\nlyrics=[00:01.00] One\\\n[00:02.00] Two\n');
    expect(tagMap(tags(), null, null)).not.toHaveProperty('lyrics');
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

describe('lyrics and ISRC in an MP3 (FFmpeg writes neither as their own ID3 frame)', () => {
  const catalog = tags({ isrc: 'USQX91300108', label: 'Columbia', lyrics: '[00:01.00] One\n[00:02.00] Two' });

  it('MP3: the ISRC goes to FFmpeg as TSRC, the lyrics are kept back for the USLT frame', () => {
    const plan = planFinalise({ file: join(dir, 'media.opus'), inputExtension: '.opus', workDir: dir, format: 'mp3', tags: catalog, existing: null, sourceUrl: null })!;
    const written = readFileSync(join(dir, 'tags.ffmeta'), 'utf8');
    expect(written).toContain('TSRC=USQX91300108');
    expect(written).toContain('publisher=Columbia');
    expect(written).not.toMatch(/^(isrc|lyrics)=/m);
    expect(plan.id3Lyrics).toBe('[00:01.00] One\n[00:02.00] Two');
  });

  it('FLAC, Opus and M4A keep FFmpeg’s generic names (LYRICS, ISRC; ©lyr), with nothing left over', () => {
    for (const format of ['flac', 'opus', 'aac'] as const) {
      const plan = planFinalise({ file: join(dir, 'media.opus'), inputExtension: '.opus', workDir: dir, format, tags: catalog, existing: null, sourceUrl: null })!;
      const written = readFileSync(join(dir, 'tags.ffmeta'), 'utf8');
      expect(written).toContain('isrc=USQX91300108');
      expect(written).toContain('lyrics=[00:01.00] One\\\n[00:02.00] Two');
      expect(plan.id3Lyrics).toBeNull();
    }
  });

  /** An ID3v2.3 tag with the frames given (id, body) and some padding, then two bytes of "audio". */
  const id3 = (frames: Array<[string, Buffer]>, padding = 16, version = 3): Buffer => {
    const body = Buffer.concat([...frames.map(([id, b]) => Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from([b.length >>> 24, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255, 0, 0]), b])), Buffer.alloc(padding)]);
    const n = body.length;
    return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, 0, (n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]), body, Buffer.from([0xff, 0xfb])]);
  };
  const text = (s: string): Buffer => Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1'), Buffer.from([0])]);
  const frameIds = (file: Buffer): string[] => {
    const ids: string[] = [];
    const end = 10 + (((file[6]! & 127) << 21) | ((file[7]! & 127) << 14) | ((file[8]! & 127) << 7) | (file[9]! & 127));
    for (let at = 10; at + 10 <= end && file[at] !== 0; at += 10 + file.readUInt32BE(at + 4)) ids.push(file.subarray(at, at + 4).toString('latin1'));
    return ids;
  };

  it('writes a USLT frame (UTF-16, "eng") in place of the TXXX FFmpeg filed lyrics under, keeping every other frame and the audio', () => {
    const before = id3([
      ['TIT2', text('Song')],
      ['TXXX', Buffer.concat([Buffer.from([0]), Buffer.from('USLT\0old words', 'latin1')])],
      ['TSRC', text('USQX91300108')],
      // What FFmpeg makes of lyrics it read from a USLT frame (`lyrics-eng`), in UTF-16 with a BOM.
      ['TXXX', Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('lyrics-eng', 'utf16le'), Buffer.from([0, 0, 0xff, 0xfe]), Buffer.from('older words', 'utf16le')])],
    ]);
    const after = withId3Lyrics(before, 'Ünïcode line\r\nsecond')!;
    expect(frameIds(after)).toEqual(['TIT2', 'TSRC', 'USLT']);
    expect(after.subarray(-2)).toEqual(Buffer.from([0xff, 0xfb]));
    const uslt = usltFrame('Ünïcode line\nsecond');
    expect(after.includes(uslt)).toBe(true);
    expect(uslt.subarray(10, 14)).toEqual(Buffer.from([1, 0x65, 0x6e, 0x67])); // UTF-16, "eng"
    expect(after.includes(Buffer.from('old words', 'latin1'))).toBe(false);
  });

  it('a file without a tag gets one; a tag it cannot rewrite safely (ID3v2.4, unsynchronised) is left alone', () => {
    const bare = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    const tagged = withId3Lyrics(bare, 'words')!;
    expect(frameIds(tagged)).toEqual(['USLT']);
    expect(tagged.subarray(-4)).toEqual(bare);
    expect(withId3Lyrics(id3([['TIT2', text('Song')]], 16, 4), 'words')).toBeNull();
    const unsync = id3([['TIT2', text('Song')]]);
    unsync[5] = 0x80;
    expect(withId3Lyrics(unsync, 'words')).toBeNull();
    expect(withId3Lyrics(bare, '  ')).toBeNull();
  });
});

// The real FFmpeg on this machine, when there is one (the hub image has it): the same plan, run, then
// read back the way a player would. Skipped where FFmpeg (or its lavfi test source) is missing.
const ffmpegHas = (encoder: string): boolean => {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { windowsHide: true, encoding: 'utf8' });
  return probe.status === 0 && new RegExp(`^\\s*A\\S*\\s+${encoder}\\s`, 'm').test(probe.stdout);
};
const realFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.2', '-f', 'null', '-'], { windowsHide: true }).status === 0;

describe.skipIf(!realFfmpeg)('with the real FFmpeg: lyrics and ISRC land where players read them', () => {
  const catalog = tags({ title: 'Test Tone', artist: 'Airwave', isrc: 'USQX91300108', label: 'Test Label', lyrics: '[00:00.10] first line\n[00:00.50] second line', license: null });
  const run = (args: string[]): void => {
    const r = spawnSync('ffmpeg', args, { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  };
  const finalise = (format: 'mp3' | 'flac' | 'opus' | 'aac'): string => {
    const source = join(dir, 'tone.wav');
    run(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', source]);
    const plan = planFinalise({ file: source, inputExtension: '.wav', workDir: dir, format, tags: catalog, existing: null, sourceUrl: null })!;
    run(plan.args);
    if (plan.id3Lyrics) expect(writeId3Lyrics(plan.output, plan.id3Lyrics)).toBe(true);
    return plan.output;
  };

  it.skipIf(!ffmpegHas('libmp3lame'))('MP3: USLT and TSRC frames (not TXXX), which music-metadata reads as lyrics and ISRC', async () => {
    const file = finalise('mp3');
    const { common, native } = await parseFile(file);
    const frames = (native['ID3v2.3'] ?? []).map((t) => t.id);
    expect(frames).toEqual(expect.arrayContaining(['TIT2', 'TPE1', 'TSRC', 'TPUB', 'USLT']));
    expect(frames).not.toContain('TXXX:USLT');
    expect(frames).not.toContain('TXXX:isrc');
    expect(common.isrc).toEqual(['USQX91300108']);
    expect(JSON.stringify(common.lyrics)).toContain('second line');
    expect(common.title).toBe('Test Tone');
  });

  it.each([
    ['flac', 'flac'],
    ['opus', 'libopus'],
  ] as const)('%s: LYRICS and ISRC comments', async (format, encoder) => {
    if (!ffmpegHas(encoder)) return;
    const { common } = await parseFile(finalise(format));
    expect(common.isrc).toEqual(['USQX91300108']);
    expect(JSON.stringify(common.lyrics)).toContain('second line');
  });

  it('M4A: ©lyr carries the lyrics (FFmpeg’s MP4 writer has no ISRC atom)', async () => {
    const { common } = await parseFile(finalise('aac'));
    expect(JSON.stringify(common.lyrics)).toContain('second line');
  });
});
