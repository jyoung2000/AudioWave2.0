/**
 * The download settings the companion hands the helper (Settings ▸ Downloads): a speed limit that
 * reaches the tool as a number and nothing else, how many jobs run at once, and the files a
 * finished job leaves for the companion to save.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HelperToolId } from '@now-playing/contracts';
import { Jobs, rateLimitOf, spotdlArgs, ytDlpArgs, type FinishedFile } from '../../src/jobs.js';
import type { ResolvedTool } from '../../src/tools.js';

const job = { url: 'https://www.youtube.com/watch?v=abc', format: 'original' } as const;

describe('a speed limit', () => {
  it('reaches yt-dlp as --limit-rate in kilobytes, built from a whole number', () => {
    const args = ytDlpArgs(job, '/tmp/j', { present: true }, { rateLimitKBps: 500 });
    expect(args[args.indexOf('--limit-rate') + 1]).toBe('500K');
    // Still before the URL, which stays last and behind `--`.
    expect(args.indexOf('--limit-rate')).toBeLessThan(args.indexOf('--'));
    expect(args.at(-1)).toBe(job.url);
  });

  it('reaches spotDL through its yt-dlp arguments, and only the limit goes there', () => {
    const args = spotdlArgs({ url: 'https://open.spotify.com/track/x', format: 'mp3' }, '/tmp/j', { present: true }, { rateLimitKBps: 2048 });
    expect(args[args.indexOf('--yt-dlp-args') + 1]).toBe('--limit-rate 2048K');
    expect(args.at(-2)).toBe('--');
  });

  it('is left out when there is none, or when it is not a sensible number', () => {
    for (const value of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000]) {
      expect(ytDlpArgs(job, '/tmp/j', { present: true }, { rateLimitKBps: value as number })).not.toContain('--limit-rate');
      expect(spotdlArgs(job, '/tmp/j', { present: true }, { rateLimitKBps: value as number })).not.toContain('--yt-dlp-args');
    }
    expect(rateLimitOf(499.6)).toBe(500);
  });
});

/** A child process that does nothing until told to exit, for watching the queue. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = undefined;
  kill(): boolean {
    this.emit('close', 1);
    return true;
  }
}

describe('how many run at once', () => {
  let root: string;
  let children: Array<{ child: FakeChild; cwd: string }>;
  const tools = async (): Promise<Record<HelperToolId, ResolvedTool>> => {
    const tool = (id: HelperToolId): ResolvedTool => ({ id, present: true, version: '1', origin: 'installed', installHint: null, installable: true, path: `/x/${id}` });
    return { 'yt-dlp': tool('yt-dlp'), spotdl: tool('spotdl'), ffmpeg: tool('ffmpeg') };
  };
  const spawnImpl = ((_command: string, _args: string[], options: { cwd: string }) => {
    const child = new FakeChild();
    children.push({ child, cwd: options.cwd });
    return child;
  }) as unknown as typeof spawn;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  /** Ends every fake process, and whatever the queue starts after them, so shutdown has nothing to wait for. */
  const drain = async (jobs: Jobs) => {
    for (let i = 0; i < 10 && jobs.busy(); i += 1) {
      for (const { child } of children) child.emit('close', 1);
      await settle();
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'np-jobs-'));
    children = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runs one at a time by default, and as many as the setting says, never more than four', async () => {
    let concurrency = 1;
    const jobs = new Jobs({ workDir: root, timeoutMs: 60_000, tools, spawnImpl, concurrency: () => concurrency });
    for (let i = 0; i < 6; i += 1) jobs.create({ url: `https://www.youtube.com/watch?v=${i}`, tool: 'yt-dlp', format: 'original' });
    await settle();
    expect(children).toHaveLength(1);

    // Raised while jobs wait: the next to finish lets two more start, up to the new limit.
    concurrency = 9;
    children[0]!.child.emit('close', 1);
    await settle();
    expect(children).toHaveLength(5);
    expect(jobs.list().filter((j) => j.state === 'running')).toHaveLength(4);
    await drain(jobs);
    await jobs.shutdown();
  });

  it('hands a finished job’s files, with where they are, to the code that started it', async () => {
    const finished: Array<{ id: string; files: FinishedFile[] }> = [];
    const jobs = new Jobs({ workDir: root, timeoutMs: 60_000, tools, spawnImpl, onFinished: (j, files) => finished.push({ id: j.id, files }) });
    const made = jobs.create({ url: 'https://www.youtube.com/watch?v=a', tool: 'yt-dlp', format: 'original' });
    await settle();
    writeFileSync(join(children[0]!.cwd, 'Song.opus'), 'audio');
    children[0]!.child.emit('close', 0);
    await settle();
    expect(finished).toHaveLength(1);
    expect(finished[0]!.id).toBe(made.id);
    expect(finished[0]!.files.map((f) => f.name)).toEqual(['Song.opus']);
    expect(finished[0]!.files[0]!.path).toBe(join(children[0]!.cwd, 'Song.opus'));
    // The job the page reads still names files by id only.
    expect(JSON.stringify(jobs.get(made.id))).not.toContain(root);
    await drain(jobs);
    await jobs.shutdown();
  });

  it('clears what finished jobs left, and job folders no job owns, but not a running job’s', async () => {
    const jobs = new Jobs({ workDir: root, timeoutMs: 60_000, tools, spawnImpl, concurrency: () => 2 });
    jobs.create({ url: 'https://www.youtube.com/watch?v=a', tool: 'yt-dlp', format: 'original' });
    const running = jobs.create({ url: 'https://www.youtube.com/watch?v=b', tool: 'yt-dlp', format: 'original' });
    mkdirSync(join(root, 'jobs', 'left-over-from-last-time'), { recursive: true });
    await settle();
    children[0]!.child.emit('close', 1);
    await settle();
    expect(await jobs.clearFinished()).toBe(2);
    expect(jobs.list().map((j) => j.id)).toEqual([running.id]);
    await drain(jobs);
    await jobs.shutdown();
  });
});
