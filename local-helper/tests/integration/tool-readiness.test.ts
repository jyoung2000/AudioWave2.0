import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HelperHealth } from '@now-playing/contracts';
import * as probe from '@now-playing/domain/tool-install';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHelper } from '../../src/server.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('health reflects current tool availability, not historical setup', () => {
  it.each([
    [false, 'ready', 'failed'],
    [false, 'installing', 'installing'],
    [false, 'failed', 'failed'],
    [true, 'ready', 'ready'],
  ] as const)('present=%s setup=%s reports %s', async (present, state, expected) => {
    vi.spyOn(probe, 'versionOf').mockResolvedValue(present ? '2026.08.19' : null);
    const root = mkdtempSync(join(tmpdir(), 'aw-readiness-')); roots.push(root);
    const helper = await startHelper({ port: 0, version: 'test', token: 'synthetic-helper-test-token', workDir: root, toolsDir: join(root, 'tools'), configured: { 'yt-dlp': join(root, 'yt-dlp.exe') }, allowedHosts: [], allowedOrigins: [], app: null, timeoutMs: 1000, log: () => {} });
    vi.spyOn(helper.tools, 'status').mockReturnValue({ 'yt-dlp': state === 'failed' ? { state, reason: 'disk full' } : { state } });
    try {
      const health = await (await fetch(`${helper.origin}/helper/v1/health`)).json() as HelperHealth;
      const tool = health.tools.find((t: { id: string }) => t.id === 'yt-dlp');
      if (!tool?.setup) throw new Error('Health omitted tool setup');
      expect(tool.present).toBe(present);
      expect(tool.setup.state).toBe(expected);
      if (!present && state === 'ready') expect(tool.setup.reason).toMatch(/version/);
      expect(JSON.stringify(tool)).not.toContain(root);
    } finally { await helper.close(); }
  });
});
