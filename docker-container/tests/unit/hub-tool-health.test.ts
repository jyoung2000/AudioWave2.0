/**
 * Verified readiness: a present file is not a ready tool. Status reads never install, probes are
 * coalesced and cached, and reasons never carry stderr, paths or installer messages.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binaryName } from '@now-playing/domain/tool-install';
import { HubTools, TOOL_REASONS, type HubToolId } from '../../src/media/tools.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'np-hub-tool-health-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const quiet = { info: () => undefined, warn: () => undefined };

function shipAll(): Record<HubToolId, string> {
  const out = {} as Record<HubToolId, string>;
  for (const id of ['yt-dlp', 'ffmpeg', 'spotdl'] as const) { out[id] = join(root, `shipped-${id}`); writeFileSync(out[id], 'x'); }
  return out;
}

describe('HubTools.health', () => {
  it('is ready only when the executable answers its version probe, and never installs', async () => {
    const asked: string[] = [];
    const probed: string[] = [];
    const tools = new HubTools({
      toolsDir: join(root, 'tools'), imagePaths: shipAll(), env: { PATH: '' }, log: quiet, platform: 'linux',
      probe: async (_path, id) => { probed.push(id); return id === 'spotdl' ? null : `${id} 1.0\r\n\u0007`; },
      install: async (id) => { asked.push(id); return { installed: false, version: null, reason: 'must not run' }; },
    });
    const status = await tools.health();
    expect(status['yt-dlp']).toEqual({ present: true, state: 'ready', version: 'yt-dlp 1.0', reason: null });
    expect(status.ffmpeg.state).toBe('ready');
    expect(status.spotdl).toEqual({ present: true, state: 'failed', version: null, reason: TOOL_REASONS.probe });
    expect(asked).toEqual([]);
    expect(probed.sort()).toEqual(['ffmpeg', 'spotdl', 'yt-dlp']);
  });

  it('reports missing, coalesces concurrent probes and caches a good answer', async () => {
    let calls = 0;
    const shipped = join(root, 'yt');
    writeFileSync(shipped, 'x');
    const tools = new HubTools({ toolsDir: null, imagePaths: { 'yt-dlp': shipped }, env: { PATH: '' }, log: quiet, platform: 'linux', probe: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return '2026.08.19'; } });
    const [a, b] = await Promise.all([tools.health(), tools.health()]);
    expect(a['yt-dlp'].state).toBe('ready');
    expect(b.ffmpeg).toEqual({ present: false, state: 'missing', version: null, reason: null });
    await tools.health();
    expect(calls).toBe(1);
  });

  it('a throwing probe is a generic failure, never stderr or a path', async () => {
    const tools = new HubTools({ toolsDir: null, imagePaths: shipAll(), env: { PATH: '' }, log: quiet, platform: 'linux', probe: async () => { throw new Error('/secret/path: permission denied'); } });
    const status = await tools.health();
    expect(JSON.stringify(status)).not.toMatch(/secret|permission/);
    expect(status.ffmpeg).toEqual({ present: true, state: 'failed', version: null, reason: TOOL_REASONS.probe });
  });

  it('replaces a present tool that does not run, and fails setup when the new copy does not run either', async () => {
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(join(toolsDir, binaryName('yt-dlp', 'win32')), 'broken');
    const asked: string[] = [];
    const warnings: object[] = [];
    let good = false;
    const tools = new HubTools({
      toolsDir, imagePaths: {}, env: { PATH: '' }, log: { info: () => undefined, warn: (d) => warnings.push(d) }, platform: 'win32',
      probe: async (_p, id) => (id === 'yt-dlp' && good ? 'fixed' : null),
      install: async (id) => { asked.push(id); if (id === 'yt-dlp') good = true; return { installed: true, version: '1', reason: null }; },
    });
    await tools.ensure();
    expect(asked).toEqual(['yt-dlp', 'ffmpeg', 'spotdl']);
    const status = tools.status();
    expect(status['yt-dlp']).toEqual({ present: true, state: 'ready', version: 'fixed', reason: null });
    // The installer said yes but nothing runs: that is a failure, with fixed words.
    expect(status.spotdl).toEqual({ present: false, state: 'failed', version: null, reason: TOOL_REASONS.setup });
    expect(warnings.length).toBe(2);
  });

  it('shows installing while a setup is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const tools = new HubTools({ toolsDir: join(root, 'tools'), imagePaths: {}, env: { PATH: '' }, log: quiet, platform: 'linux', probe: async () => null, install: async () => { await gate; return { installed: false, version: null, reason: 'offline' }; } });
    const run = tools.ensure();
    await new Promise((r) => setTimeout(r, 10));
    expect(tools.status()['yt-dlp'].state).toBe('installing');
    expect(tools.ensure()).toBe(run);
    release();
    await run;
    expect(tools.status()['yt-dlp'].state).toBe('failed');
  });

  it('a failing image-shipped copy is reported failed, never replaced', async () => {
    const asked: string[] = [];
    const tools = new HubTools({
      toolsDir: join(root, 'tools'), imagePaths: shipAll(), env: { PATH: '' }, log: quiet, platform: 'linux',
      probe: async () => null,
      install: async (id) => { asked.push(id); return { installed: false, version: null, reason: 'must not run' }; },
    });
    await tools.ensure();
    expect(asked, 'the image copy wins resolution; a re-download could never repair it').toEqual([]);
    expect(tools.status()['yt-dlp']).toEqual({ present: true, state: 'failed', version: null, reason: TOOL_REASONS.probe });
  });

  it('returns checking immediately while a coalesced health probe runs in the background', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let probes = 0;
    const tools = new HubTools({ toolsDir: null, imagePaths: shipAll(), env: { PATH: '' }, log: quiet,
      probe: async () => { probes += 1; await gate; return '1.0'; },
    });
    const first = tools.snapshot();
    expect(first['yt-dlp'].state).toBe('checking');
    expect(tools.snapshot().spotdl.state).toBe('checking');
    expect(probes).toBe(1);
    release();
    await tools.health();
    expect(tools.snapshot()['yt-dlp']).toEqual({ present: true, state: 'ready', version: '1.0', reason: null });
    expect(probes).toBe(3);
  });

  it('status refresh joins startup setup instead of probing the same PyInstaller copy twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let probes = 0;
    const tools = new HubTools({ toolsDir: join(root, 'tools'), imagePaths: shipAll(), env: { PATH: '' }, log: quiet,
      probe: async () => { probes += 1; await gate; return '1.0'; },
    });
    const startup = tools.ensure();
    tools.snapshot();
    tools.snapshot();
    const overlapped = probes;
    release();
    await startup;
    await tools.health();
    expect(overlapped).toBe(1);
    expect(probes).toBe(3);
  });
});
