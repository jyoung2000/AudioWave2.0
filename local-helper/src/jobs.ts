/**
 * Running the tool, and turning what it leaves behind into files the player can take.
 *
 * Everything the client can influence is here in one place — the URL, which tool, which output
 * format — and everything else is fixed by this file. In particular `--ignore-config` is not
 * decoration: without it, a `yt-dlp.conf` sitting in the user's home directory would be read and
 * obeyed, and one of the flags it could add is `--exec`. A web page must not be able to reach that
 * even indirectly, so the tool is told to ignore every configuration file and is handed a command
 * line built entirely from this module.
 *
 * One job runs at a time. These are network-bound and disk-bound, two at once is not twice as fast,
 * and a queue of one keeps the progress people are watching truthful.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HelperJob, HelperJobFile, HelperToolId, OutputFormat } from '@now-playing/contracts';
import { sanitizeFilename } from '@now-playing/domain';
import { toolCommand, type ResolvedTool } from './tools.js';

/** How long a killed tool gets to actually exit before its directory is removed anyway. */
const CLOSE_WAIT_MS = 5000;

/** What these tools actually emit. Anything else in the directory is a by-product, not a track. */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.opus', '.ogg', '.oga', '.wav', '.webm', '.alac', '.mka']);

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.alac': 'audio/mp4',
  '.mka': 'audio/x-matroska',
};

export interface JobRequest {
  url: string;
  tool: HelperToolId;
  format: OutputFormat;
}

interface Running {
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Settles once the process has exited, so its files are no longer held open. */
  closed: Promise<void>;
}

interface Record_ {
  job: HelperJob;
  /** Everything this job owns: `out` for the tool's files and `home` for spotDL's profile. */
  root: string;
  directory: string;
  home: string;
  /** Absolute paths, kept here so a filesystem path is never part of an API response. */
  paths: Map<string, string>;
  running: Running | null;
  cancelled: boolean;
}

export interface JobsOptions {
  /** A directory this run owns outright. Everything under it may be deleted. */
  workDir: string;
  timeoutMs: number;
  /** Finished jobs, and their files, are dropped this long after they finish. */
  finishedTtlMs?: number;
  log?: (line: string) => void;
  /** Looked up per job rather than captured, so installing a tool takes effect without a restart. */
  tools: () => Promise<Record<HelperToolId, ResolvedTool>>;
  /** Kept for the tests, which need to watch a job without waiting on a real download. */
  spawnImpl?: typeof spawn;
  onChange?: (job: HelperJob) => void;
}

export class Jobs {
  private readonly records = new Map<string, Record_>();
  private queue: string[] = [];
  private active: string | null = null;

  constructor(private readonly options: JobsOptions) {
    mkdirSync(join(options.workDir, 'jobs'), { recursive: true });
  }

  create(request: JobRequest): HelperJob {
    const id = randomUUID();
    const root = join(this.options.workDir, 'jobs', id);
    const directory = join(root, 'out');
    const home = join(root, 'home');
    mkdirSync(directory, { recursive: true });
    mkdirSync(home, { recursive: true });
    const job: HelperJob = {
      id,
      state: 'queued',
      url: request.url,
      tool: request.tool,
      format: request.format,
      stage: 'preflight',
      percent: null,
      message: null,
      files: [],
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.records.set(id, { job, root, directory, home, paths: new Map(), running: null, cancelled: false });
    this.queue.push(id);
    void this.pump();
    return job;
  }

  get(id: string): HelperJob | null {
    return this.records.get(id)?.job ?? null;
  }

  list(): HelperJob[] {
    return [...this.records.values()].map((r) => r.job);
  }

  filePath(jobId: string, fileId: string): { path: string; file: HelperJobFile } | null {
    const record = this.records.get(jobId);
    const path = record?.paths.get(fileId);
    const file = record?.job.files.find((f) => f.id === fileId);
    return path && file ? { path, file } : null;
  }

  /** Whether anything is running or waiting — while so, a tool binary may be held open. */
  busy(): boolean {
    return this.active !== null || this.queue.length > 0;
  }

  /**
   * Stops it if it is running, and takes its working directory with it either way.
   *
   * The record goes first and unconditionally: a directory Windows will not let go of must not leave
   * a job behind that counts against the cap forever.
   */
  async forget(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    record.cancelled = true;
    const running = record.running;
    if (running) {
      clearTimeout(running.timer);
      killTree(running.child);
      this.finish(record, { state: 'cancelled', error: 'Cancelled.' });
      // The files stay locked until the process tree is gone.
      await Promise.race([running.closed, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref())]);
    }
    this.remove(record.root);
    return true;
  }

  /** Drop finished jobs older than the TTL. */
  async sweep(now: number = Date.now()): Promise<void> {
    const ttl = this.options.finishedTtlMs ?? 60 * 60 * 1000;
    const stale = [...this.records.values()].filter((r) => r.job.finishedAt && now - Date.parse(r.job.finishedAt) >= ttl).map((r) => r.job.id);
    await Promise.allSettled(stale.map((id) => this.forget(id)));
  }

  /** Make room by dropping the job that finished longest ago. False when nothing has finished. */
  async evictOldestFinished(): Promise<boolean> {
    const finished = [...this.records.values()].filter((r) => r.job.finishedAt).sort((a, b) => Date.parse(a.job.finishedAt!) - Date.parse(b.job.finishedAt!));
    const oldest = finished[0];
    return oldest ? this.forget(oldest.job.id) : false;
  }

  /** Called on shutdown: nothing this program made should outlive it. One failure does not stop the rest. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.records.keys()].map((id) => this.forget(id)));
  }

  private remove(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      this.options.log?.(`could not remove a job directory: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const id = this.queue.shift();
    if (!id) return;
    const record = this.records.get(id);
    if (!record) return void this.pump();
    this.active = id;
    try {
      await this.run(record);
    } catch (error) {
      if (!record.cancelled) this.finish(record, { state: 'failed', error: redactPaths(error instanceof Error ? error.message : String(error), record).slice(0, 600) });
    } finally {
      this.active = null;
      void this.pump();
    }
  }

  private async run(record: Record_): Promise<void> {
    const tools = await this.options.tools();
    const tool = tools[record.job.tool];
    if (!tool.present || !tool.path) throw new Error(`${record.job.tool} is not installed on this machine.`);
    const ffmpeg = tools.ffmpeg;
    if (record.job.tool === 'spotdl' && !ffmpeg.present) throw new Error('spotDL needs FFmpeg, and there is none on this machine.');
    if (record.job.format !== 'original' && !ffmpeg.present) throw new Error(`Converting to ${record.job.format} needs FFmpeg, and there is none on this machine.`);

    const args = record.job.tool === 'yt-dlp' ? ytDlpArgs(record.job, record.directory, ffmpeg) : spotdlArgs(record.job, record.directory, ffmpeg);
    // Forgotten while the tools were being looked up: there is nothing left to run it for.
    if (record.cancelled) return;
    this.patch(record, { state: 'running', stage: 'fetching' });

    // spotDL has no switch to ignore its config file, and loads it whenever one exists under the
    // home directory. Giving it an empty home of its own is the equivalent of `--ignore-config`.
    const env = record.job.tool === 'spotdl' ? childEnv(process.env, { HOME: record.home, USERPROFILE: record.home }) : childEnv();
    const { command, prefix } = toolCommand(tool.path);
    const spawnImpl = this.options.spawnImpl ?? spawn;
    await new Promise<void>((resolve, reject) => {
      let settle: () => void = () => {};
      const closed = new Promise<void>((done) => {
        settle = done;
      });
      // Its own process group elsewhere, so the whole tree can be killed at once; Windows uses taskkill.
      const child = spawnImpl(command, [...prefix, ...args], { cwd: record.directory, stdio: ['ignore', 'pipe', 'pipe'], env, shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      const timer = setTimeout(() => killTree(child), this.options.timeoutMs);
      record.running = { child, timer, closed };
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => this.readProgress(record, chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      // A pipe that breaks while the tool is being killed must not take the helper down with it.
      child.stdout?.on('error', () => {});
      child.stderr?.on('error', () => {});
      child.on('error', (error) => {
        clearTimeout(timer);
        record.running = null;
        settle();
        reject(new Error(`${record.job.tool} could not be started: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        record.running = null;
        settle();
        if (code === 0) resolve();
        else reject(new Error(lastMeaningfulLine(stderr) ?? `${record.job.tool} exited with code ${code ?? 'unknown'}.`));
      });
    });

    if (record.cancelled) return;
    this.patch(record, { stage: 'finalizing' });
    const files = this.collect(record);
    if (!files.length) throw new Error(`${record.job.tool} finished without producing an audio file.`);
    this.finish(record, { state: 'done', files });
  }

  /**
   * yt-dlp with `--newline` puts one progress line per update, which is the whole reason that flag
   * is there. spotDL reports per song rather than per byte, so its percentage stays null and its
   * own last line is shown instead — a made-up number would be worse than none.
   */
  private readProgress(record: Record_, chunk: string): void {
    if (record.cancelled) return;
    for (const line of chunk.split(/\r?\n/)) {
      // yt-dlp names full paths ("Destination: C:\Users\…"); the page only ever sees a file name.
      const text = redactPaths(line.trim(), record);
      if (!text) continue;
      const percent = /^\[download\]\s+([\d.]+)%/.exec(text);
      if (percent) {
        this.patch(record, { percent: Math.min(100, Number(percent[1])), stage: 'fetching', message: text.slice(0, 400) });
        continue;
      }
      if (/^\[(ExtractAudio|Merger|VideoConvertor|EmbedThumbnail|Metadata)\]/.test(text)) {
        this.patch(record, { stage: 'converting', message: text.slice(0, 400) });
        continue;
      }
      this.patch(record, { message: text.slice(0, 400) });
    }
  }

  private collect(record: Record_): HelperJobFile[] {
    const files: HelperJobFile[] = [];
    for (const name of walk(record.directory)) {
      const extension = extname(name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(extension)) continue;
      const absolute = join(record.directory, name);
      const id = randomUUID();
      record.paths.set(id, absolute);
      files.push({
        id,
        // The name is rebuilt rather than trusted: it came from a page title on someone else's site.
        name: sanitizeFilename(name.split(/[/\\]/).pop() ?? `track${extension}`, { fallback: `track${extension}` }),
        sizeBytes: statSync(absolute).size,
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
      });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  private patch(record: Record_, patch: Partial<HelperJob>): void {
    record.job = { ...record.job, ...patch };
    this.options.onChange?.(record.job);
  }

  private finish(record: Record_, patch: Partial<HelperJob>): void {
    this.patch(record, { stage: 'done', finishedAt: new Date().toISOString(), ...patch });
  }
}

/**
 * The command line, built here and nowhere else.
 *
 * `--ignore-config` comes first because everything after it is only true if no configuration file
 * got a say.
 */
export function ytDlpArgs(job: Pick<HelperJob, 'url' | 'format'>, directory: string, ffmpeg: { present: boolean; path?: string | null }): string[] {
  const args = [
    '--ignore-config',
    '--no-colors',
    '--newline',
    '--no-mtime',
    '--no-cache-dir',
    // A link can point at a whole album; a cap stops one paste from becoming a thousand files.
    '--playlist-end',
    '200',
    '--paths',
    directory,
    '--output',
    '%(title).180B.%(ext)s',
  ];
  if (ffmpeg.present) {
    if (ffmpeg.path) args.push('--ffmpeg-location', ffmpeg.path);
    args.push('--extract-audio', '--embed-metadata');
    if (job.format !== 'original') args.push('--audio-format', job.format);
  } else {
    // No FFmpeg means no extracting and no merging, so ask for a single stream that is already audio.
    args.push('--format', 'bestaudio/best');
  }
  args.push('--', urlArgument(job.url));
  return args;
}

/** A URL on a command line is only ever a URL: it starts with a scheme, so it cannot be read as a flag. */
function urlArgument(url: string): string {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be handed to a tool.');
  return url;
}

/**
 * spotDL never gives you Spotify's audio — it reads Spotify for the track list and then fetches a
 * match from YouTube Music, which is why it needs FFmpeg and why "original" means nothing to it.
 * Asking for the original therefore gets MP3, which is what it would have produced anyway.
 */
export function spotdlArgs(job: Pick<HelperJob, 'url' | 'format'>, directory: string, ffmpeg: { present: boolean; path?: string | null }): string[] {
  const args = ['download', '--output', join(directory, '{artists} - {title}.{output-ext}'), '--format', job.format === 'original' ? 'mp3' : job.format];
  if (ffmpeg.path) args.push('--ffmpeg', ffmpeg.path);
  // Last and behind `--`, as for yt-dlp.
  args.push('--', urlArgument(job.url));
  return args;
}

/**
 * A deliberately small environment. The tool gets what it needs to find its own libraries and a
 * temporary directory, and nothing that would identify the person running it or let it pick up
 * credentials lying around in the shell.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (source[key]) env[key] = source[key];
  // Python writes .pyc files beside whatever it imports otherwise, including in a read-only place.
  env['PYTHONDONTWRITEBYTECODE'] = '1';
  return { ...env, ...overrides };
}

/**
 * Kill the tool and everything it started. yt-dlp starts FFmpeg, and killing only yt-dlp leaves
 * FFmpeg running with the job's files open — on Windows that means they cannot be deleted.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) child.kill('SIGKILL');
    });
    return;
  }
  try {
    // Negative: the process group the tool leads, because it was spawned detached.
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Take absolute paths out of a line a page will see. Known directories go first, so a file the tool
 * wrote shows as its name; anything else that looks like a path loses everything before its last
 * separator.
 */
export function redactPaths(text: string, dirs: { directory: string; root?: string }): string {
  let out = text;
  for (const known of [dirs.directory, dirs.root, tmpdir(), homedir()]) {
    if (!known) continue;
    for (const spelling of new Set([known, known.replace(/\\/g, '/')])) {
      const pattern = new RegExp(`${escapeRegExp(spelling)}[\\\\/]?`, process.platform === 'win32' ? 'gi' : 'g');
      out = out.replace(pattern, '');
    }
  }
  return out.replace(/\b[A-Za-z]:[\\/](?:[^\\/\s"']+[\\/])+/g, '').replace(/(^|[\s"'=])\/(?:[^/\s"']+\/)+/g, '$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Depth-limited, because a tool that made a thousand nested directories has already gone wrong. */
function walk(directory: string, prefix = '', depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(directory, entry.name), relative, depth + 1));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

/** Tools put the useful part of a failure last, after a stack of warnings nobody needs. */
export function lastMeaningfulLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^WARNING:/i.test(l));
  const last = lines.at(-1);
  return last ? last.replace(/^ERROR:\s*/i, '').slice(0, 600) : null;
}
