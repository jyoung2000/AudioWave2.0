/**
 * The command line, and where things live on each platform.
 *
 * Hand-rolled rather than pulled from a package, because this program's whole pitch is that it is
 * one small file you can read before you run it, and an argument parser is fifty lines.
 *
 * Everything has a default that works. Running `now-playing-helper` with no arguments at all should
 * open the player with the tools wired up — if it needs a flag to be useful, it has failed at the
 * thing it exists to do.
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HELPER_DEFAULT_HOSTS, HELPER_DEFAULT_PORT } from '@now-playing/contracts';

export interface Options {
  port: number;
  /** Where the player is: a built directory, the single-file build, or null to serve the API only. */
  app: string | null;
  serveApp: boolean;
  open: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  toolsDir: string;
  workDir: string;
  timeoutMs: number;
  tools: { 'yt-dlp'?: string | undefined; spotdl?: string | undefined; ffmpeg?: string | undefined };
  help: boolean;
  showVersion: boolean;
}

export const HELP = `now-playing-helper — run yt-dlp and spotDL for the Now Playing player

  A browser page cannot start a program. This can. It serves the player on a
  loopback address and runs the tools on its behalf, so the two share an origin
  and there is nothing to configure.

  It does not ship the tools. It finds what you have installed, and it can fetch
  yt-dlp for you — verified against the checksums published with that release.

Usage
  now-playing-helper [options]

Options
  --port <n>            Port to listen on (default ${HELPER_DEFAULT_PORT}; the player also probes the next few)
  --app <path>          The player to serve: a built directory or now-playing.html
  --no-app              Serve the API only, for a player hosted somewhere else
  --no-open             Do not open a browser on start
  --allow-origin <o>    Let a player on this origin call the helper (repeatable)
  --allow-host <h>      Add a host the tools may fetch from (repeatable)
  --only-hosts <a,b>    Replace the host allowlist entirely
  --tools-dir <path>    Where an installed yt-dlp is kept
  --yt-dlp <path>       Use this yt-dlp instead of looking for one
  --spotdl <path>       Use this spotDL instead of looking for one
  --ffmpeg <path>       Use this FFmpeg instead of looking for one
  --timeout <seconds>   Give up on a single job after this long (default 900)
  --version             Print the version and exit
  --help                Print this and exit

It listens on 127.0.0.1 only, and every request that starts work carries a token
printed at startup and placed in the page it serves.

You are responsible for what you fetch with it. Each request records why you are
entitled to the file, and the helper refuses without that. See
docs/DOWNLOADS_AND_LEGAL.md.
`;

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    port: HELPER_DEFAULT_PORT,
    app: null,
    serveApp: true,
    open: true,
    allowedOrigins: [],
    allowedHosts: [...HELPER_DEFAULT_HOSTS],
    toolsDir: join(dataDir(), 'tools'),
    workDir: join(tmpdir(), 'now-playing-helper'),
    timeoutMs: 900_000,
    tools: {},
    help: false,
    showVersion: false,
  };
  let replacedHosts = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.showVersion = true;
        break;
      case '--port':
        options.port = portOf(next());
        break;
      case '--app':
        options.app = next();
        break;
      case '--no-app':
        options.serveApp = false;
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--open':
        options.open = true;
        break;
      case '--allow-origin':
        options.allowedOrigins.push(originOf(next()));
        break;
      case '--allow-host':
        options.allowedHosts.push(hostOf(next()));
        break;
      case '--only-hosts': {
        // Repeating it adds rather than replacing again, so two flags do not silently drop the first.
        const hosts = next().split(',').filter(Boolean).map(hostOf);
        options.allowedHosts = replacedHosts ? [...options.allowedHosts, ...hosts] : hosts;
        replacedHosts = true;
        break;
      }
      case '--tools-dir':
        options.toolsDir = next();
        break;
      case '--work-dir':
        options.workDir = next();
        break;
      case '--yt-dlp':
        options.tools['yt-dlp'] = next();
        break;
      case '--spotdl':
        options.tools.spotdl = next();
        break;
      case '--ffmpeg':
        options.tools.ffmpeg = next();
        break;
      case '--timeout': {
        const seconds = Number(next());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout needs a number of seconds.');
        options.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      default:
        throw new Error(`Unknown option ${arg}. Try --help.`);
    }
  }
  return options;
}

function portOf(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${value} is not a port.`);
  return port;
}

/** An origin is scheme + host + port and nothing else; a path here means a misunderstanding. */
function originOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${value} is not an origin. It should look like https://example.github.io.`);
  }
  return url.origin;
}

function hostOf(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253) throw new Error(`${value} is not a hostname.`);
  return host;
}

/** Where an installed tool should live so it is still there next time, per platform convention. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'NowPlaying');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'NowPlaying');
  return join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'now-playing');
}
