/**
 * What a download carries (UX-DL-001): cover art and clean tags when FFmpeg is here, and a plain
 * statement of what is missing when it is not — without any text from a site reaching a command line.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HelperJob, HelperToolId } from '@now-playing/contracts';
import { FFMPEG_MISSING_NOTE, Jobs, spotdlSaveArgs, withCleanTags, ytDlpArgs, ytDlpInfoArgs } from '../../src/jobs.js';
import type { ResolvedTool } from '../../src/tools.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'resolve');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
const job = (format: 'original' | 'mp3' = 'original', url = 'https://www.youtube.com/watch?v=abc') => ({ url, format }) as const;

describe('the download’s command line', () => {
  it('embeds the thumbnail as JPEG cover art and writes the tags when FFmpeg is here', () => {
    const args = ytDlpArgs(job(), '/tmp/j', { present: true, path: '/usr/bin/ffmpeg' });
    expect(args[0]).toBe('--ignore-config');
    expect(args).toEqual(expect.arrayContaining(['--extract-audio', '--embed-metadata', '--embed-thumbnail']));
    expect(args[args.indexOf('--convert-thumbnails') + 1]).toBe('jpg');
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('asks for nothing it cannot do without FFmpeg', () => {
    const args = ytDlpArgs(job(), '/tmp/j', { present: false });
    for (const flag of ['--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', '--extract-audio', '--load-info-json']) expect(args).not.toContain(flag);
    expect(args).toContain('bestaudio/best');
  });

  it('downloads from the cleaned description when given one: the file is ours, and no URL is on the line', () => {
    const args = ytDlpArgs(job('mp3'), '/tmp/j', { present: true }, {}, { infoFile: '/tmp/root/info.json' });
    // Without --no-clean-infojson yt-dlp drops a loaded playlist's entries and fetches it all again.
    expect(args.slice(-3)).toEqual(['--no-clean-infojson', '--load-info-json', '/tmp/root/info.json']);
    expect(args).not.toContain('--');
    expect(args).not.toContain('https://www.youtube.com/watch?v=abc');
    expect(args[args.indexOf('--playlist-end') + 1]).toBe('200');
    // The job's URL is still checked, so a job that is not a link fails before anything runs.
    expect(() => ytDlpArgs(job('mp3', '--exec=calc'), '/tmp/j', { present: true }, {}, { infoFile: '/tmp/root/info.json' })).toThrow(/http/);
  });

  it('describes the link without downloading, with the same first flag, cap and URL rule', () => {
    const args = ytDlpInfoArgs({ url: 'https://www.youtube.com/watch?v=a&b=--exec' });
    expect(args[0]).toBe('--ignore-config');
    expect(args).toContain('--dump-single-json');
    expect(args[args.indexOf('--playlist-end') + 1]).toBe('200');
    expect(args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=a&b=--exec']);
    expect(() => ytDlpInfoArgs({ url: '--exec=calc' })).toThrow(/http/);
  });

  it('asks spotDL to save, not download, with the URL where spotDL takes it', () => {
    expect(spotdlSaveArgs('https://open.spotify.com/track/x', '/tmp/s/songs.spotdl')).toEqual(['save', 'https://open.spotify.com/track/x', '--save-file', '/tmp/s/songs.spotdl']);
    expect(() => spotdlSaveArgs('--config', '/tmp/s')).toThrow(/http/);
  });
});

describe('clean tags on the description', () => {
  it('cleans a YouTube video title into title, artist and the whole date', () => {
    const out = withCleanTags(fixture('yt-dlp-youtube-video.json'));
    expect(out).toMatchObject({ meta_title: 'Never Gonna Give You Up', meta_artist: 'Rick Astley', meta_album_artist: 'Rick Astley', meta_date: '2009-10-25', meta_genre: '' });
    // The original title is left alone: it is what the file is named after.
    expect(out['title']).toBe('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)');
  });

  it('writes features into the artist tag as "A feat. B", and the album artist alone', () => {
    const out = withCleanTags({ title: 'Calvin Harris ft. Rihanna - This Is What You Came For (Official Video)', channel: 'CalvinHarrisVEVO', extractor_key: 'Youtube', upload_date: '20160429' });
    expect(out).toMatchObject({ meta_title: 'This Is What You Came For', meta_artist: 'Calvin Harris feat. Rihanna', meta_album_artist: 'Calvin Harris', meta_date: '2016-04-29' });
  });

  it('keeps a source’s own track, artist, genre and release date', () => {
    expect(withCleanTags(fixture('yt-dlp-soundcloud-track.json'))).toMatchObject({ meta_title: 'Flickermood', meta_artist: 'Forss', meta_genre: 'Electronic', meta_date: '2003-06-02' });
  });

  it('cleans every entry of a playlist on its own, keeps the set’s album, and drops what the download never reads', () => {
    const out = withCleanTags({
      _type: 'playlist',
      title: 'An EP',
      entries: [
        { title: 'One', track: 'One', artist: 'Band', album: 'An EP', upload_date: '20120728', automatic_captions: { en: [] } },
        // A song the site withheld is null; loaded back, it would make yt-dlp refetch everything.
        null,
        { title: 'Band - Two (Official Audio)', channel: 'Band', extractor_key: 'Youtube' },
      ],
    });
    const entries = out['entries'] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ meta_title: 'One', meta_artist: 'Band', meta_album: 'An EP', meta_date: '2012-07-28' });
    expect(entries[0]).not.toHaveProperty('automatic_captions');
    expect(entries[1]).toMatchObject({ meta_title: 'Two', meta_artist: 'Band' });
    expect(out).not.toHaveProperty('meta_title');
  });
});

/** A child process that does nothing until told to exit. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  kill(): boolean {
    this.emit('close', 1);
    return true;
  }
}

describe('a download, start to finish', () => {
  let root: string;
  let calls: Array<{ child: FakeChild; args: string[]; cwd: string }>;
  const tool = (id: HelperToolId, present = true): ResolvedTool => ({ id, present, version: present ? '1' : null, origin: present ? 'installed' : 'missing', installHint: null, installable: true, path: present ? `/x/${id}` : null });
  const spawnImpl = ((_command: string, args: string[], options: { cwd: string }) => {
    const child = new FakeChild();
    calls.push({ child, args, cwd: options.cwd });
    return child;
  }) as unknown as typeof spawn;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const answer = async (child: FakeChild, stdout: string, code = 0) => {
    child.stdout.write(stdout);
    await settle();
    child.emit('close', code);
    await settle();
  };
  const make = (ffmpeg: boolean) => {
    const done: HelperJob[] = [];
    const jobs = new Jobs({ workDir: root, timeoutMs: 60_000, tools: async () => ({ 'yt-dlp': tool('yt-dlp'), spotdl: tool('spotdl'), ffmpeg: tool('ffmpeg', ffmpeg) }), spawnImpl, onChange: (j) => j.finishedAt && done.push(j) });
    return { jobs, done };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'np-tags-'));
    calls = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('describes, cleans, then downloads from the cleaned description', async () => {
    const { jobs, done } = make(true);
    jobs.create({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', tool: 'yt-dlp', format: 'mp3' });
    await settle();
    expect(calls[0]!.args).toEqual(ytDlpInfoArgs({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
    await answer(calls[0]!.child, JSON.stringify(fixture('yt-dlp-youtube-video.json')));
    const second = calls[1]!.args;
    const infoFile = second.at(-1)!;
    expect(second.at(-2)).toBe('--load-info-json');
    // In the job's own folder, beside (not inside) the folder the tool writes audio into.
    expect(infoFile.startsWith(join(root, 'jobs'))).toBe(true);
    expect(infoFile.startsWith(calls[1]!.cwd)).toBe(false);
    expect(JSON.parse(readFileSync(infoFile, 'utf8'))).toMatchObject({ meta_title: 'Never Gonna Give You Up', meta_artist: 'Rick Astley', meta_date: '2009-10-25' });
    writeFileSync(join(calls[1]!.cwd, 'Rick Astley - Never Gonna Give You Up.mp3'), 'audio');
    await answer(calls[1]!.child, '[download] 100.0% of 3.00MiB\n');
    expect(done[0]).toMatchObject({ state: 'done' });
    expect(done[0]!.message).not.toBe(FFMPEG_MISSING_NOTE);
    await jobs.shutdown();
    expect(existsSync(infoFile)).toBe(false);
  });

  it('falls back to naming the URL when the description cannot be read', async () => {
    const { jobs } = make(true);
    jobs.create({ url: 'https://www.youtube.com/watch?v=a', tool: 'yt-dlp', format: 'original' });
    await settle();
    await answer(calls[0]!.child, 'not json');
    expect(calls[1]!.args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=a']);
    calls[1]!.child.emit('close', 1);
    await settle();
    await jobs.shutdown();
  });

  it('fails with the tool’s own reason when the link cannot be described', async () => {
    const { jobs, done } = make(true);
    jobs.create({ url: 'https://www.youtube.com/watch?v=a', tool: 'yt-dlp', format: 'original' });
    await settle();
    calls[0]!.child.stderr.write('ERROR: [youtube] a: Video unavailable\n');
    await answer(calls[0]!.child, '', 1);
    expect(calls).toHaveLength(1);
    expect(done[0]).toMatchObject({ state: 'failed', error: '[youtube] a: Video unavailable' });
    await jobs.shutdown();
  });

  it('downloads the rest of a playlist when the site withholds some of its songs', async () => {
    // What yt-dlp did with a SoundCloud set on 2026-10-04: three songs DRM-protected, the other
    // three described, exit code 1.
    const { jobs } = make(true);
    jobs.create({ url: 'https://soundcloud.com/band/sets/an-ep', tool: 'yt-dlp', format: 'original' });
    await settle();
    calls[0]!.child.stderr.write('ERROR: [soundcloud] 75206121: This video is DRM protected\n');
    await answer(calls[0]!.child, JSON.stringify({ _type: 'playlist', title: 'An EP', entries: [{ title: 'Two', track: 'Two', artist: 'Band', album: 'An EP', upload_date: '20120728' }] }), 1);
    const second = calls[1]!.args;
    expect(second.at(-2)).toBe('--load-info-json');
    const saved = JSON.parse(readFileSync(second.at(-1)!, 'utf8')) as { entries: Array<Record<string, unknown>> };
    expect(saved.entries[0]).toMatchObject({ meta_title: 'Two', meta_artist: 'Band', meta_album: 'An EP' });
    calls[1]!.child.emit('close', 1);
    await settle();
    await jobs.shutdown();
  });

  it('without FFmpeg, downloads in one go and says what the file lacks', async () => {
    const { jobs, done } = make(false);
    jobs.create({ url: 'https://www.youtube.com/watch?v=a', tool: 'yt-dlp', format: 'original' });
    await settle();
    expect(calls[0]!.args).not.toContain('--dump-single-json');
    expect(calls[0]!.args.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=a']);
    writeFileSync(join(calls[0]!.cwd, 'a.webm'), 'audio');
    await answer(calls[0]!.child, '');
    expect(done[0]).toMatchObject({ state: 'done', message: FFMPEG_MISSING_NOTE });
    expect(FFMPEG_MISSING_NOTE).toMatch(/FFmpeg/);
    expect(FFMPEG_MISSING_NOTE).toMatch(/cover art/);
    await jobs.shutdown();
  });
});
