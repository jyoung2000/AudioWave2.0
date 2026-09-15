/**
 * What runs when someone double-clicks this.
 *
 * The success case is meant to be boring: it prints where the player is, what it found, and what it
 * did not find — then it opens a browser and gets out of the way. The failure cases are where the
 * care goes, because the person reading them is not the person who wrote this. A port already in
 * use, a directory it cannot write to and a missing player are all things that happen, and each one
 * gets a sentence saying what to do rather than a stack trace.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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

  try {
    mkdirSync(options.workDir, { recursive: true });
  } catch (error) {
    out(`Cannot use ${options.workDir} for temporary files: ${error instanceof Error ? error.message : String(error)}`);
    out('Point somewhere writable with --work-dir <path>.');
    return 1;
  }

  const token = newToken();
  const helper = await listen(options, app, token, out);
  if (!helper) return 1;

  const tools = await resolveAll({ configured: options.tools, toolsDir: options.toolsDir });
  out('');
  out(`  Now Playing helper ${VERSION}`);
  out(`  ${app ? 'Player and tools' : 'Tools'} at  ${helper.origin}`);
  out('');
  for (const tool of [tools['yt-dlp'], tools.spotdl, tools.ffmpeg]) {
    out(`  ${tool.present ? '·' : '!'} ${tool.id.padEnd(8)} ${tool.present ? (tool.version ?? 'present') : 'not installed'}`);
  }
  if (!tools['yt-dlp'].present) out(`    yt-dlp is the one that matters. The player can fetch it for you from Settings → Platforms.`);
  if (!tools.ffmpeg.present) out(`    Without FFmpeg nothing can be converted, and the player will say so.`);
  out('');
  if (!app) {
    out(`  Serving the API only. Allowed origins: ${options.allowedOrigins.length ? options.allowedOrigins.join(', ') : 'none yet — add one with --allow-origin'}`);
    out(`  Token (paste it into Settings → Platforms):`);
    out(`    ${token}`);
    out('');
  }
  out('  Press Ctrl+C to stop. Anything half-downloaded goes with it.');
  out('');

  if (app && options.open) openBrowser(helper.origin);

  const stop = async (): Promise<void> => {
    out('\nStopping.');
    await helper.close();
    rmSync(options.workDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
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
