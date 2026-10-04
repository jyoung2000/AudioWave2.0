/**
 * The environment the hub's command-line tools run in.
 *
 * What the tool may inherit: where programs are, and — on Windows — the three variables without
 * which a process cannot open a socket or a temporary file. Nothing else: no tokens, no proxy
 * credentials, no home directory to read a configuration file from.
 *
 * And where it may unpack itself. The yt-dlp the image ships is a PyInstaller one-file bundle: on
 * every start it unpacks a Python runtime into `$TMPDIR` and loads shared libraries from there. In
 * the container `/tmp` is a 64 MB tmpfs, mounted `noexec` as Docker does by default — too small to
 * unpack into, and a place nothing may be loaded from even if it were larger (Hermes, 2026-10-04:
 * `--version` exited 255 with 64 MB and failed to map `libz.so.1` with 512 MB). So the tool gets its
 * own scratch folder on the data volume, which is large and allows execution, and `/tmp` keeps the
 * protection it has for everything else.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** `<dataDir>/tmp/tools`, created if missing; null for a hub with no disk, whose tools keep the default. */
export function toolScratchDir(dataDir: string): string | null {
  if (dataDir === ':memory:') return null;
  const dir = join(dataDir, 'tmp', 'tools');
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export function toolEnvironment(scratchDir: string | null, from: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: from['PATH'] ?? from['Path'] ?? '/usr/bin:/bin' };
  if (platform === 'win32') for (const key of ['SystemRoot', 'TEMP', 'TMP']) if (from[key]) env[key] = from[key];
  if (scratchDir) {
    env['TMPDIR'] = scratchDir;
    if (platform === 'win32') {
      env['TEMP'] = scratchDir;
      env['TMP'] = scratchDir;
    }
  }
  return env;
}
