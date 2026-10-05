/**
 * Running one of the hub's command-line tools and reading what it printed.
 *
 * No shell, ever: the arguments are an array handed to the program as they are, so nothing in a URL
 * or a title can become a second command. A configured path that is a JavaScript file is run with
 * this Node (`toolCommand`), which is how the tests stand in for yt-dlp and spotDL. The process is
 * killed when it overruns its time or the caller gives up, and what it printed is capped so a tool
 * that floods its output cannot fill the hub's memory.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { findOnPath, toolCommand } from '@now-playing/domain/tool-install';

export interface RunToolOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Default 32 MiB: a 200-entry playlist's JSON is a few hundred kilobytes. */
  maxStdoutBytes?: number;
}

export class ToolRunError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = 'ToolRunError';
  }
}

export function runTool(binary: string, args: readonly string[], options: RunToolOptions): Promise<{ stdout: string; stderr: string }> {
  const max = options.maxStdoutBytes ?? 32 * 1024 * 1024;
  return new Promise((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted) {
      rejectPromise(options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted'));
      return;
    }
    const { command, prefix } = toolCommand(binary);
    const child = spawn(command, [...prefix, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      size += d.byteLength;
      if (size > max) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = `${stderr}${d.toString()}`.slice(-4000);
    });
    const settle = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      settle();
      rejectPromise(new ToolRunError(`could not be started: ${err.message}`, null, '', false));
    });
    child.on('close', (code) => {
      settle();
      if (options.signal?.aborted) rejectPromise(options.signal.reason instanceof Error ? options.signal.reason : new Error('Aborted'));
      else if (overflow) rejectPromise(new ToolRunError(`printed more than ${Math.round(max / 1024 / 1024)} MiB`, code, stderr, false));
      else if (timedOut) rejectPromise(new ToolRunError(`did not finish within ${Math.round(options.timeoutMs / 1000)} s`, code, stderr, true));
      else if (code !== 0) rejectPromise(new ToolRunError(`exited with code ${code}`, code, stderr, false));
      else resolvePromise({ stdout: Buffer.concat(chunks).toString('utf8'), stderr });
    });
  });
}

/**
 * A program's full path. The hub may know FFmpeg as just `ffmpeg` (found on PATH); a tool told
 * `--ffmpeg-location ffmpeg` reads that as a path and finds nothing, so it is given the file itself.
 */
export function resolveExecutable(path: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!path) return null;
  if (isAbsolute(path) || /[\\/]/.test(path)) return path;
  return findOnPath(path, env) ?? path;
}

/** The last useful line a tool wrote to stderr, for a message a person reads. */
export function lastError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((l) => /error/i.test(l));
  return (error ?? lines.at(-1) ?? '').slice(0, 300);
}
