import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as probe from '@now-playing/domain/tool-install';
import { resolveTool, cachedResolver, toolSetupFor } from '../../src/tools.js';

afterEach(() => vi.restoreAllMocks());

describe('runtime tool readiness', () => {
  it('allows yt-dlp time to unpack, like the installer does', async () => {
    const version = vi.spyOn(probe, 'versionOf').mockResolvedValue('2026.08.19');
    await resolveTool('yt-dlp', { configured: { 'yt-dlp': 'C:/app data/tools/yt-dlp.exe' }, toolsDir: 'C:/nonexistent-tools' });
    expect(version).toHaveBeenCalledWith('C:/app data/tools/yt-dlp.exe', 'yt-dlp', 60_000);
  });
  it('recovers a managed executable after invalidating a failed probe', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'aw-managed-probe-'));
    const managed = join(toolsDir, probe.binaryName('yt-dlp'));
    writeFileSync(managed, 'test-only executable; probe is mocked');
    const version = vi.spyOn(probe, 'versionOf').mockResolvedValue(null);
    const resolver = cachedResolver({ configured: {}, toolsDir });
    try {
      const first = (await resolver.get())['yt-dlp'];
      expect(first.present).toBe(false);
      expect(first.installHint).toMatch(/found but did not report a version/);
      version.mockImplementation(async (path) => path === managed ? '2026.08.19' : null);
      resolver.invalidate();
      expect((await resolver.get())['yt-dlp']).toMatchObject({ present: true, origin: 'installed', version: '2026.08.19' });
      expect(version).toHaveBeenCalledWith(managed, 'yt-dlp', 60_000);
    } finally { rmSync(toolsDir, { recursive: true, force: true }); }
  });
  it('never calls a missing executable ready because an earlier install succeeded', () => {
    expect(toolSetupFor({ present: false }, { state: 'ready' })).toEqual({ state: 'failed', reason: expect.stringMatching(/version|run/i) });
  });
  it('keeps active setup and real failures visible while the tool is missing', () => {
    expect(toolSetupFor({ present: false }, { state: 'installing', progress: 0.5 })).toEqual({ state: 'installing', progress: 0.5 });
    expect(toolSetupFor({ present: false }, { state: 'failed', reason: 'disk full' })).toEqual({ state: 'failed', reason: 'disk full' });
    expect(toolSetupFor({ present: false }, undefined)).toBeUndefined();
  });
  it('keeps repair failure details and active updates visible for a runnable copy', () => {
    expect(toolSetupFor({ present: true }, { state: 'failed', reason: 'disk full' })).toEqual({ state: 'failed', reason: 'disk full' });
    expect(toolSetupFor({ present: true }, { state: 'installing', progress: 0 })).toEqual({ state: 'installing', progress: 0 });
  });
});
