/**
 * After a restore the hub's process must actually be gone.
 *
 * The in-process restore test injects `exit` and checks it was called, which proves the intent and
 * nothing about the operating system. The defect this guards against lived below that: a hub that
 * answered the restore and then stayed in the process table — closed database, open port — where a
 * supervisor saw nothing to restart. So this test runs the real entry point as a real process and
 * asks the process table.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HUB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Signal 0 sends nothing; it only asks whether the process exists. */
function inProcessTable(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let child: ChildProcess | null = null;
let dataDir: string | null = null;

afterEach(() => {
  if (child?.pid && inProcessTable(child.pid)) child.kill('SIGKILL');
  child = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  dataDir = null;
});

describe('restore, as a process', () => {
  it('leaves nothing in the process table and frees the port', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'np-hub-restore-proc-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: HUB_ROOT,
      env: { ...process.env, NP_DATA_DIR: dataDir, NP_PORT: String(port), NP_LOG_LEVEL: 'warn', NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    const exited = new Promise<number | null>((resolve) => child!.once('exit', (code) => resolve(code)));
    const pid = child.pid!;

    await until(
      'the hub to answer /healthz',
      async () => {
        if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`The hub exited early (${child.exitCode}):\n${output}`);
        return fetch(`${base}/healthz`).then((r) => r.ok, () => false);
      },
      60_000,
    );

    let cookie = '';
    let csrf = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof json['csrfToken'] === 'string') csrf = json['csrfToken'];
      return { status: response.status, json };
    };

    expect((await call('POST', '/auth/login', { username: 'admin', password: 'admin' })).status).toBe(200);
    expect((await call('POST', '/auth/change-password', { currentPassword: 'admin', newPassword: 'a-long-enough-password-1' })).status).toBe(200);
    const backup = await call('POST', '/backup');
    expect(backup.status, JSON.stringify(backup.json)).toBe(201);

    const restored = await call('POST', `/backup/${String(backup.json['id'])}/restore`, { confirm: true });
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    expect(restored.json).toMatchObject({ ok: true, restartRequired: true });

    // The response came first; the exit follows it. Zero, so a supervisor restarts rather than alarms.
    const code = await Promise.race([exited, new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 15_000))]);
    expect(code, output).toBe(0);
    await until('the pid to leave the process table', () => !inProcessTable(pid), 5_000);
    expect(inProcessTable(pid)).toBe(false);
    // And the port is free again: nothing inherited the listening socket.
    await until('the port to be released', () => fetch(`${base}/healthz`).then(() => false, () => true), 5_000);
  }, 120_000);
});
