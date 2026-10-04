/**
 * Asking a tool what it is. A path that will not answer its version flag is not a tool, whatever
 * its name says — the installer checks this before a download is moved into place, and the helper
 * and the hub check it before they use one.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { HelperToolId } from '@now-playing/contracts';

const run = promisify(execFile);

/**
 * How to start a tool at `path`. A configured path that is a JavaScript file is run with this Node,
 * because Windows cannot execute a script by its name without a shell, and a shell is not an option.
 */
export function toolCommand(path: string): { command: string; prefix: string[] } {
  return /\.(?:mjs|cjs|js)$/i.test(path) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
}

/** FFmpeg and ffprobe take `-version`; everything else here takes `--version`. */
export function versionFlag(path: string, id?: HelperToolId): string {
  if (id === 'ffmpeg') return '-version';
  return /^(?:ffmpeg|ffprobe)(?:\.exe)?$/i.test(basename(path)) ? '-version' : '--version';
}

/**
 * The first line of the version flag's output, which is all any of these put there that is worth keeping.
 * `env`, when given, is the whole environment the tool runs in — the one it will really be run with,
 * so a tool that can start in one environment and not the other is asked in the right one.
 */
export async function versionOf(path: string, id?: HelperToolId, timeoutMs = 8000, env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { command, prefix } = toolCommand(path);
    const { stdout } = await run(command, [...prefix, versionFlag(path, id)], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 256, ...(env ? { env } : {}) });
    const first = stdout.split(/\r?\n/)[0]?.trim() ?? '';
    return first.slice(0, 120) || null;
  } catch {
    return null;
  }
}

/**
 * PATH, walked by hand rather than shelled out to `which`, because a shell is the thing this
 * program is trying not to need.
 */
export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env['PATH'] ?? env['Path'] ?? '';
  const extensions = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      // On Windows the name already carries .exe; only try the others when it does not.
      const candidate = join(directory, binary.toLowerCase().endsWith(extension.toLowerCase()) ? binary : `${binary}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable directory on PATH — normal, and not this program's problem.
      }
    }
  }
  return null;
}
