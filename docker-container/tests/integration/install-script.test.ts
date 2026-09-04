/**
 * The `nowplaying` install and update command.
 *
 * Docker is not available in the test environment, and installing a real one would test Docker
 * rather than this script. So `docker` is replaced with a stub on PATH that records what it was
 * asked to do — which is exactly what these tests are about: whether the script runs the right
 * commands, keeps the profiles you chose, refuses what it does not understand, and genuinely
 * detaches so an update survives the terminal closing.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hubDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(hubDir, 'nowplaying');
const dataDir = join(hubDir, 'data');

let stubDir: string;

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
  try {
    const output = execFileSync('/bin/sh', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: options.exclusive ? prefix : `${prefix}:${process.env['PATH'] ?? ''}` },
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
      for (const tool of ['dirname', 'basename']) {
        const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
        symlinkSync(found, join(bare, tool));
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
      execFileSync('sh', ['-c', 'sleep 0.2']);
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
