/**
 * What runs when someone double-clicks this.
 *
 * The success case is meant to be boring: it prints where the player is, what it found, and what it
 * did not find — then it opens a browser and gets out of the way. The failure cases are where the
 * care goes, because the person reading them is not the person who wrote this. A port already in
 * use, a directory it cannot write to and a missing player are all things that happen, and each one
 * gets a sentence saying what to do rather than a stack trace.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_PORT_SCAN } from '@now-playing/contracts';
import { findApp } from './app.js';
import { parseArgs, HELP } from './options.js';
import { newToken } from './security.js';
import { startHelper } from './server.js';
import { resolveAll } from './tools.js';

const VERSION = process.env['NP_VERSION'] ?? '0.0.0-dev';

export async function main(argv: readonly string[] = process.argv.slice(2), out: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (options.help) {
    out(HELP);
    return 0;
  }
  if (options.showVersion) {
    out(VERSION);
    return 0;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const app = options.serveApp ? findApp(options.app, here) : null;
  if (options.serveApp && !app) {
    out('Could not find a player to serve.');
    out('Put now-playing.html beside this program, or point at one with --app <path>.');
    out('To run the API only — for a player hosted somewhere else — use --no-app.');
    return 1;
  }

  // `--work-dir` may be a folder the user cares about, and a second helper may share it. So this run
  // gets a new folder of its own inside it, and that folder is the only thing it ever deletes.
  let runDir: string;
  try {
    mkdirSync(options.workDir, { recursive: true });
    runDir = mkdtempSync(join(options.workDir, 'now-playing-run-'));
  } catch (error) {
    out(`Cannot use ${options.workDir} for temporary files: ${error instanceof Error ? error.message : String(error)}`);
    out('Point somewhere writable with --work-dir <path>.');
    return 1;
  }
  const removeRunDir = (): void => {
    try {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      out(`Could not remove ${runDir}; it is safe to delete by hand.`);
    }
  };

  const token = newToken();
  const helper = await listen({ ...options, workDir: runDir }, app, token, out);
  if (!helper) {
    removeRunDir();
    return 1;
  }

  const tools = await resolveAll({ configured: options.tools, toolsDir: options.toolsDir });
  out('');
  out(`  Now Playing helper ${VERSION}`);
  out(`  ${app ? 'Player and tools' : 'Tools'} at  ${helper.origin}`);
  out('');
  for (const tool of [tools['yt-dlp'], tools.spotdl, tools.ffmpeg]) {
    const missing = options.autoTools && tool.installable ? 'setting up — verified download' : 'not installed';
    out(`  ${tool.present ? '·' : '!'} ${tool.id.padEnd(8)} ${tool.present ? (tool.version ?? 'present') : missing}`);
  }
  if (!options.autoTools && !tools['yt-dlp'].present) out(`    yt-dlp is the one that matters. Run without --no-auto-tools and it is set up for you.`);
  if (!tools.ffmpeg.present && !tools.ffmpeg.installable) out(`    Without FFmpeg nothing can be converted. ${tools.ffmpeg.installHint ?? ''}`.trimEnd());
  out('');

  // Missing tools are set up in the background, one at a time, so the player is usable at once.
  // Failed ones are retried after six hours; the check also keeps the yt-dlp it set up current.
  let setupTimer: NodeJS.Timeout | null = null;
  if (options.autoTools) {
    void helper.tools.ensure({ ignoreBackoff: true }).catch((error: unknown) => out(`  Tool setup stopped: ${error instanceof Error ? error.message : String(error)}`));
    setupTimer = setInterval(() => void helper.tools.ensure().catch(() => undefined), 60 * 60 * 1000);
    setupTimer.unref();
  }
  if (!app) {
    out(`  Serving the API only. Allowed origins: ${options.allowedOrigins.length ? options.allowedOrigins.join(', ') : 'none yet — add one with --allow-origin'}`);
    out(`  Token (paste it into Settings → Platforms):`);
    out(`    ${token}`);
    out('');
  }
  out('  Press Ctrl+C to stop. Anything half-downloaded goes with it.');
  out('');

  if (app && options.open) openBrowser(helper.origin);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    out('\nStopping.');
    if (setupTimer) clearInterval(setupTimer);
    try {
      await helper.close();
    } finally {
      removeRunDir();
      process.exit(0);
    }
  };
  // SIGHUP is a closed terminal, and on Windows also a closed console window; SIGBREAK is Ctrl+Break.
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? (['SIGBREAK'] as const) : [])];
  for (const signal of signals) process.on(signal, () => void stop());
  return 0;
}

/**
 * Take the asked-for port, or the next few.
 *
 * The player probes the same small range, so a helper that had to move is still found. Moving
 * silently is right here: the alternative is telling someone their music app cannot start because
 * something else owns a number.
 */
async function listen(options: ReturnType<typeof parseArgs>, app: ReturnType<typeof findApp>, token: string, out: (line: string) => void): Promise<Awaited<ReturnType<typeof startHelper>> | null> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < HELPER_PORT_SCAN; attempt += 1) {
    const port = options.port + attempt;
    try {
      return await startHelper({
        port,
        version: VERSION,
        token,
        workDir: options.workDir,
        toolsDir: options.toolsDir,
        timeoutMs: options.timeoutMs,
        allowedHosts: options.allowedHosts,
        allowedOrigins: options.allowedOrigins,
        app,
        configured: options.tools,
        backup: options.backup,
        log: (line) => out(`  ${line}`),
      });
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  out(`Could not listen on ${options.port}–${options.port + HELPER_PORT_SCAN - 1}: ${message}`);
  out('Another copy may already be running. Close it, or choose a different port with --port.');
  return null;
}

/** Best effort, and never fatal: the address is printed above whether or not this works. */
function openBrowser(url: string): void {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    child.on('error', () => {
      // No browser opener on this machine. The URL is on screen; that is enough.
    });
    child.unref();
  } catch {
    // Same.
  }
}

// Only when run, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exit(1);
    },
  );
}
