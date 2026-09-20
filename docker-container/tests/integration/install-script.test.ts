/**
 * The `nowplaying` install and update command.
 *
 * Docker is not available in the test environment, and installing a real one would test Docker
 * rather than this script. So `docker` is replaced with a stub on PATH that records what it was
 * asked to do — which is exactly what these tests are about: whether the script runs the right
 * commands, keeps the profiles you chose, refuses what it does not understand, and genuinely
 * detaches so an update survives the terminal closing.
 *
 * The script is POSIX shell, so the tests need a POSIX shell to run it. On Windows that is Git's
 * bundled `sh`, which every contributor already has because the repository is cloned with Git; the
 * suite locates it rather than being skipped, because the script it covers is the one users run to
 * install the hub and nothing else tests it.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hubDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(hubDir, 'nowplaying');
const dataDir = join(hubDir, 'data');

let stubDir: string;

/**
 * The shell, and the directory its standard tools live in.
 *
 * On Linux and macOS the tools are already on PATH. Git's shell on Windows keeps its `dirname`,
 * `basename` and friends beside itself in `usr/bin`, which is *not* on the Windows PATH — without
 * it the script starts and then fails on its very first line with "dirname: command not found".
 */
function posixShellDir(): [shell: string, toolsDir: string | null] {
  if (existsSync('/bin/sh')) return ['/bin/sh', null];
  const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const gitExe of found) {
    // Walk up rather than assuming a depth: `where git` answers `Git/cmd/git.exe` from one shell
    // and `Git/mingw64/bin/git.exe` from another, and only the install root has `usr/bin/sh.exe`.
    let dir = dirname(gitExe);
    for (let up = 0; up < 4; up += 1) {
      for (const candidate of [join(dir, 'usr', 'bin', 'sh.exe'), join(dir, 'bin', 'sh.exe')]) {
        if (existsSync(candidate)) return [candidate, dirname(candidate)];
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error(`No POSIX shell found (git: ${found.join(', ') || 'not on PATH'}). On Windows these tests use the sh that ships with Git; install Git or run them under WSL.`);
}

/**
 * Block for a moment without shelling out.
 *
 * The poll below waits on a *detached* process, so the wait has to be synchronous. It used to run
 * `sh -c 'sleep 0.2'`, which needs a `sh` on PATH and spawns a process per tick; `Atomics.wait` on
 * a buffer nobody else touches does the same job on every platform with no process at all.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A `docker` that answers `info` and echoes everything else, so the script's own logic is exercised. */
function installDockerStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'np-stub-'));
  const path = join(dir, 'docker');
  writeFileSync(
    path,
    ['#!/usr/bin/env sh', 'case "$1" in', '  info) exit 0 ;;', '  compose) shift; echo "compose $*" ;;', '  exec) echo "healthy, version test" ;;', '  image) exit 0 ;;', '  *) echo "docker $*" ;;', 'esac', ''].join('\n'),
  );
  chmodSync(path, 0o755);
  return dir;
}

/** `exclusive` replaces PATH entirely rather than prepending, for the "tool is absent" cases. */
function run(args: string[], options: { path?: string; exclusive?: boolean } = {}): { status: number; output: string } {
  const prefix = options.path ?? stubDir;
  // Resolved outside the try: a shell that cannot be found is a broken environment, not a script
  // that exited non-zero, and swallowing it into `{ status: 1, output: '' }` makes every assertion
  // in this file fail with no clue why.
  const [shell, toolsDir] = posixShellDir();
  // `exclusive` still gets the shell's own tools: the point of that mode is a PATH without
  // `docker`, not one without a working shell.
  const rest = [options.exclusive ? null : process.env['PATH'], toolsDir].filter(Boolean).join(delimiter);
  try {
    // Forward slashes: a POSIX shell treats a backslash as an escape, so a Windows path reaches it
    // with every separator eaten and the script "does not exist". Both shells accept `C:/...`.
    const output = execFileSync(shell, [script.split(sep).join('/'), ...args], {
      encoding: 'utf8',
      // `delimiter`, not ':' -- PATH is ';'-separated on Windows, and one wrong character turns the
      // whole list into a single nonexistent directory, so every tool the script needs disappears.
      env: { ...process.env, PATH: rest ? `${prefix}${delimiter}${rest}` : prefix },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeEach(() => {
  stubDir = installDockerStub();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the command itself', () => {
  it('prints its own documentation rather than a separate copy that can drift', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.output).toContain('./nowplaying install');
    // The header comment is the source of the help text, so no shell code leaks into it.
    expect(help.output).not.toContain('set -eu');
  });

  it('refuses a command and an option it does not understand', () => {
    expect(run(['bogus']).status).not.toBe(0);
    expect(run(['bogus']).output).toMatch(/Unknown command/);
    expect(run(['install', '--nope']).output).toMatch(/Unknown option/);
  });

  it('says where to get Docker when it is not installed at all', () => {
    // A PATH with the few tools the script needs to start, and deliberately no `docker`.
    const bare = mkdtempSync(join(tmpdir(), 'np-nodocker-'));
    try {
      // Shell implementations rather than copies of the real tools. `command -v dirname` answers a
      // POSIX path under MSYS (`/usr/bin/dirname`), which Node reads as `C:\usr\bin\dirname` and
      // cannot copy; symlinking needs Developer Mode; and an MSYS binary moved out of its own
      // directory loses the DLL beside it. All the script asks of these two is `dirname "$0"` and
      // `basename "$0"`, which is a few lines of shell on any platform.
      const shims: Record<string, string> = {
        dirname: ['#!/usr/bin/env sh', 'case "$1" in', '  */*) printf "%s\\n" "${1%/*}" ;;', '  *) printf ".\\n" ;;', 'esac', ''].join('\n'),
        basename: ['#!/usr/bin/env sh', 'printf "%s\\n" "${1##*/}"', ''].join('\n'),
      };
      for (const [tool, body] of Object.entries(shims)) {
        const shim = join(bare, tool);
        writeFileSync(shim, body);
        chmodSync(shim, 0o755);
      }
      const result = run(['status'], { path: bare, exclusive: true });
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/Docker is not installed/);
      expect(result.output).toMatch(/docs\.docker\.com/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('distinguishes “Docker is not running” from “Docker is not installed”', () => {
    // A docker that exists but whose daemon refuses: the fix is different, so the message must be.
    const dir = mkdtempSync(join(tmpdir(), 'np-downdocker-'));
    try {
      const path = join(dir, 'docker');
      writeFileSync(path, '#!/usr/bin/env sh\nexit 1\n');
      chmodSync(path, 0o755);
      const result = run(['status'], { path: dir });
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/installed but not running/);
      expect(result.output).toMatch(/docker' group/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install', () => {
  it('builds, then starts detached so the containers outlive the terminal', () => {
    const result = run(['install']);
    expect(result.status).toBe(0);
    expect(result.output).toContain('compose -f');
    expect(result.output).toMatch(/build/);
    // `up -d`: the containers are not tied to this shell.
    expect(result.output).toMatch(/up -d --remove-orphans/);
    expect(result.output).toMatch(/admin \/ admin/);
    expect(result.output).toMatch(/set a real password before anything else is enabled/);
  });

  it('remembers that the Discord bot was asked for, so later updates bring it back', () => {
    expect(run(['install', '--discord']).output).toMatch(/--profile discord up -d/);
    expect(readFileSync(join(dataDir, '.profiles'), 'utf8').trim()).toBe('discord');
    // An update run days later, by a timer, with nobody watching, keeps the same set.
    expect(run(['update']).output).toMatch(/--profile discord up -d/);
  });

  it('does not open the hub to the network on its own, even when asked to', () => {
    const result = run(['install', '--lan']);
    // The flag is a prompt to edit two settings deliberately, not something this script does for you.
    expect(result.output).toMatch(/will not\s+make your hub reachable behind your back/);
    expect(result.output).toMatch(/NP_BIND_MODE=lan/);
  });
});

describe('update', () => {
  it('rebuilds and recreates the containers', () => {
    const result = run(['update']);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/build --pull/);
    expect(result.output).toMatch(/up -d --remove-orphans/);
  });

  it('detaches so it finishes even if the terminal is closed', () => {
    const result = run(['update', '--detach']);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/You can close this terminal/);
    // It returns straight away and names the log, rather than holding the terminal open.
    expect(result.output).toMatch(/Log:\s+\S+\.log/);

    const logDir = join(dataDir, 'logs');
    const deadline = Date.now() + 15_000;
    let logs: string[] = [];
    while (Date.now() < deadline) {
      logs = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith('-update.log')) : [];
      if (logs.length && readFileSync(join(logDir, logs[0]!), 'utf8').includes('Update finished')) break;
      sleepSync(200);
    }
    expect(logs.length, 'the detached run should have written a log').toBeGreaterThan(0);
    const log = readFileSync(join(logDir, logs[0]!), 'utf8');
    // The work really happened in the background process, not in the foreground one that returned.
    expect(log).toMatch(/build --pull/);
    expect(log).toMatch(/Update finished/);
  });
});

describe('scheduling', () => {
  it('explains what to do when neither systemd nor cron is available', () => {
    const empty = mkdtempSync(join(tmpdir(), 'np-nosched-'));
    try {
      mkdirSync(dataDir, { recursive: true });
      const result = run(['schedule', '--weekly'], { path: empty });
      expect(result.status).not.toBe(0);
      expect(result.output).toMatch(/launchd|Task Scheduler|NAS/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses an interval it does not understand', () => {
    expect(run(['schedule', '--hourly']).output).toMatch(/--daily, --weekly or --off/);
  });
});
