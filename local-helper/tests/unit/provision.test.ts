/**
 * Automatic setup, with the resolver, the installer and GitHub all replaced by tables — so what is
 * tested is the policy: what gets installed, in what order, what is left alone, when a failure is
 * retried and when yt-dlp is replaced.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HelperToolId } from '@now-playing/contracts';
import type { InstallOutcome } from '../../src/install.js';
import { ensureTools, RETRY_AFTER_MS, STATE_FILE, ToolProvisioner, UPDATE_CHECK_MS, type EnsureOptions } from '../../src/provision.js';
import type { ResolvedTool } from '../../src/tools.js';

type World = Partial<Record<HelperToolId, { origin: ResolvedTool['origin']; version: string }>>;

let toolsDir: string;
let world: World;
let installs: HelperToolId[];
let failing: Set<HelperToolId>;
let clock: number;

const resolve = async (id: HelperToolId): Promise<ResolvedTool> => {
  const found = world[id];
  return found
    ? { id, present: true, version: found.version, origin: found.origin, installHint: null, installable: true, path: `/x/${id}` }
    : { id, present: false, version: null, origin: 'missing', installHint: 'hint', installable: true, path: null };
};

const install = async (id: HelperToolId, options: { onProgress?: (r: number, t: number | null) => void }): Promise<InstallOutcome> => {
  installs.push(id);
  options.onProgress?.(50, 100);
  if (failing.has(id)) return { installed: false, version: null, reason: `${id} refused: no SHA-256`, tag: 'v1' };
  world[id] = { origin: 'installed', version: '2026.09.20' };
  return { installed: true, version: '2026.09.20', reason: null, tag: '2026.09.20' };
};

const options = (extra: Partial<EnsureOptions> = {}): EnsureOptions => ({
  toolsDir,
  configured: {},
  platform: 'win32',
  arch: 'x64',
  now: () => clock,
  resolve,
  install,
  release: async () => ({ tag: '2026.09.20', assets: [] }),
  ...extra,
});

beforeEach(() => {
  toolsDir = mkdtempSync(join(tmpdir(), 'np-provision-'));
  world = {};
  installs = [];
  failing = new Set();
  clock = Date.parse('2026-09-27T12:00:00Z');
});

afterEach(() => rmSync(toolsDir, { recursive: true, force: true }));

describe('setting the tools up', () => {
  it('installs every missing tool, one at a time, yt-dlp then FFmpeg then spotDL', async () => {
    const seen: string[] = [];
    const result = await ensureTools(options({ onStatus: (id, s) => seen.push(`${id}:${s.state}${s.progress !== undefined ? `:${s.progress}` : ''}`) }));
    expect(installs).toEqual(['yt-dlp', 'ffmpeg', 'spotdl']);
    expect(result.setup).toEqual({ 'yt-dlp': { state: 'ready' }, ffmpeg: { state: 'ready' }, spotdl: { state: 'ready' } });
    // Progress is reported while it downloads, and each finishes before the next starts.
    expect(seen.slice(0, 3)).toEqual(['yt-dlp:installing:0', 'yt-dlp:installing:0.5', 'yt-dlp:ready']);
  });

  it('leaves a tool on PATH or given on the command line alone', async () => {
    world = { 'yt-dlp': { origin: 'path', version: '2020.01.01' }, ffmpeg: { origin: 'configured', version: 'ffmpeg version 7' } };
    const result = await ensureTools(options());
    expect(installs).toEqual(['spotdl']);
    expect(result.setup['yt-dlp']).toEqual({ state: 'ready' });
    expect(result.setup.ffmpeg).toEqual({ state: 'ready' });
  });

  it('says a tool is unsupported, with what to do, where nothing is published', async () => {
    const result = await ensureTools(options({ platform: 'linux', arch: 'x64' }));
    expect(installs).toEqual(['yt-dlp', 'spotdl']);
    expect(result.setup.ffmpeg.state).toBe('unsupported');
    expect(result.setup.ffmpeg.reason).toMatch(/package manager/);
  });

  it('records a failure and waits six hours before trying again, unless told to try now', async () => {
    failing.add('spotdl');
    const first = await ensureTools(options());
    expect(first.setup.spotdl).toEqual({ state: 'failed', reason: 'spotdl refused: no SHA-256' });
    expect(JSON.parse(readFileSync(join(toolsDir, STATE_FILE), 'utf8')).tools.spotdl.lastError).toBe('spotdl refused: no SHA-256');

    installs = [];
    clock += RETRY_AFTER_MS - 1000;
    const soon = await ensureTools(options());
    expect(installs).toEqual([]);
    expect(soon.setup.spotdl.state).toBe('failed');

    // Next start (or "Try Again") does not wait.
    await ensureTools(options({ ignoreBackoff: true }));
    expect(installs).toEqual(['spotdl']);

    installs = [];
    clock += RETRY_AFTER_MS;
    failing.clear();
    const later = await ensureTools(options());
    expect(installs).toEqual(['spotdl']);
    expect(later.setup.spotdl).toEqual({ state: 'ready' });
  });

  it('replaces the yt-dlp it set up when a newer release is out, at most once a day', async () => {
    world = { 'yt-dlp': { origin: 'installed', version: '2026.08.01' }, ffmpeg: { origin: 'path', version: '7' }, spotdl: { origin: 'path', version: '4' } };
    await ensureTools(options());
    expect(installs).toEqual(['yt-dlp']);
    expect(world['yt-dlp']!.version).toBe('2026.09.20');

    // A day has not passed: no check, even though (pretend) another release came out.
    installs = [];
    world['yt-dlp'] = { origin: 'installed', version: '2026.08.01' };
    clock += UPDATE_CHECK_MS / 2;
    await ensureTools(options());
    expect(installs).toEqual([]);

    clock += UPDATE_CHECK_MS;
    await ensureTools(options());
    expect(installs).toEqual(['yt-dlp']);
  });

  it('never replaces a yt-dlp it did not set up, and waits for running jobs before replacing its own', async () => {
    world = { 'yt-dlp': { origin: 'path', version: '2020.01.01' }, ffmpeg: { origin: 'path', version: '7' }, spotdl: { origin: 'path', version: '4' } };
    await ensureTools(options());
    expect(installs).toEqual([]);

    world['yt-dlp'] = { origin: 'installed', version: '2020.01.01' };
    await ensureTools(options({ busy: () => true }));
    expect(installs).toEqual([]);
  });

  it('keeps a current yt-dlp as it is', async () => {
    world = { 'yt-dlp': { origin: 'installed', version: '2026.09.20' }, ffmpeg: { origin: 'path', version: '7' }, spotdl: { origin: 'path', version: '4' } };
    await ensureTools(options());
    expect(installs).toEqual([]);
  });
});

describe('the provisioner a server holds', () => {
  it('reports nothing before it has looked, then each tool’s state, and queues a manual install', async () => {
    failing.add('ffmpeg');
    const provisioner = new ToolProvisioner(options());
    expect(provisioner.status()).toEqual({});
    await provisioner.ensure();
    expect(provisioner.status().ffmpeg).toMatchObject({ state: 'failed' });
    expect(provisioner.installing()).toBeNull();

    failing.clear();
    const outcome = await provisioner.install('ffmpeg');
    expect(outcome.installed).toBe(true);
    expect(provisioner.status().ffmpeg).toEqual({ state: 'ready' });
  });

  it('shows a failed tool as queued the moment "try again" is pressed', async () => {
    failing.add('spotdl');
    const provisioner = new ToolProvisioner(options());
    await provisioner.ensure();
    failing.clear();
    const again = provisioner.ensure({ ignoreBackoff: true });
    expect(provisioner.status().spotdl).toEqual({ state: 'installing', progress: 0 });
    await again;
    expect(provisioner.status().spotdl).toEqual({ state: 'ready' });
  });
});
