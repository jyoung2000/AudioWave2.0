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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HelperJob, HelperJobFile, HelperToolId, OutputFormat } from '@now-playing/contracts';
import { sanitizeFilename } from '@now-playing/domain';
import type { ResolvedTool } from './tools.js';

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
}

interface Record_ {
  job: HelperJob;
  directory: string;
  /** Absolute paths, kept here so a filesystem path is never part of an API response. */
  paths: Map<string, string>;
  running: Running | null;
}

export interface JobsOptions {
  workDir: string;
  timeoutMs: number;
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
    const directory = join(this.options.workDir, 'jobs', id);
    mkdirSync(directory, { recursive: true });
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
    this.records.set(id, { job, directory, paths: new Map(), running: null });
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

  /** Stops it if it is running, and takes its working directory with it either way. */
  forget(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.running) {
      clearTimeout(record.running.timer);
      record.running.child.kill('SIGKILL');
      this.finish(record, { state: 'cancelled', error: 'Cancelled.' });
    }
    this.queue = this.queue.filter((q) => q !== id);
    rmSync(record.directory, { recursive: true, force: true });
    this.records.delete(id);
    return true;
  }

  /** Called on shutdown: nothing this program made should outlive it. */
  shutdown(): void {
    for (const id of [...this.records.keys()]) this.forget(id);
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
      this.finish(record, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
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
    this.patch(record, { state: 'running', stage: 'fetching' });

    const spawnImpl = this.options.spawnImpl ?? spawn;
    await new Promise<void>((resolve, reject) => {
      const child = spawnImpl(tool.path!, args, { cwd: record.directory, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), shell: false, windowsHide: true });
      const timer = setTimeout(() => child.kill('SIGKILL'), this.options.timeoutMs);
      record.running = { child, timer };
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => this.readProgress(record, chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        record.running = null;
        reject(new Error(`${record.job.tool} could not be started: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        record.running = null;
        if (code === 0) resolve();
        else reject(new Error(lastMeaningfulLine(stderr) ?? `${record.job.tool} exited with code ${code ?? 'unknown'}.`));
      });
    });

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
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
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
  args.push('--', job.url);
  return args;
}

/**
 * spotDL never gives you Spotify's audio — it reads Spotify for the track list and then fetches a
 * match from YouTube Music, which is why it needs FFmpeg and why "original" means nothing to it.
 * Asking for the original therefore gets MP3, which is what it would have produced anyway.
 */
export function spotdlArgs(job: Pick<HelperJob, 'url' | 'format'>, directory: string, ffmpeg: { present: boolean; path?: string | null }): string[] {
  const args = ['download', job.url, '--output', join(directory, '{artists} - {title}.{output-ext}'), '--format', job.format === 'original' ? 'mp3' : job.format];
  if (ffmpeg.path) args.push('--ffmpeg', ffmpeg.path);
  return args;
}

/**
 * A deliberately small environment. The tool gets what it needs to find its own libraries and a
 * temporary directory, and nothing that would identify the person running it or let it pick up
 * credentials lying around in the shell.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (source[key]) env[key] = source[key];
  // Python writes .pyc files beside whatever it imports otherwise, including in a read-only place.
  env['PYTHONDONTWRITEBYTECODE'] = '1';
  return env;
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
