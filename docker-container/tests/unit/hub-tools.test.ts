/**
 * The hub's own downloaders: found where they are, or set up — verified — where they are not.
 * No network here: the installer is injected.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binaryName } from '@now-playing/domain/tool-install';
import { HubTools } from '../../src/media/tools.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-hub-tools-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const quiet = { info: () => undefined, warn: () => undefined };

describe('HubTools', () => {
  it('finds a tool in its own folder', () => {
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(join(toolsDir, binaryName('yt-dlp')), 'x');
    const tools = new HubTools({ toolsDir, imagePaths: {}, env: { PATH: '' }, log: quiet });
    expect(tools.locate('yt-dlp')).toBe(join(toolsDir, binaryName('yt-dlp')));
    expect(tools.locate('ffmpeg')).toBeNull();
  });

  it('finds spotDL where the image puts it, beside yt-dlp', () => {
    const shipped = join(root, 'shipped-spotdl');
    writeFileSync(shipped, 'x');
    const tools = new HubTools({ toolsDir: join(root, 'tools'), imagePaths: { spotdl: shipped }, env: { PATH: '' }, log: quiet });
    expect(tools.locate('spotdl')).toBe(shipped);
    expect(tools.status().spotdl).toEqual({ present: true, reason: null });
  });

  it('finds spotDL in its own folder and on PATH', () => {
    const toolsDir = join(root, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(join(toolsDir, binaryName('spotdl')), 'x');
    expect(new HubTools({ toolsDir, imagePaths: {}, env: { PATH: '' }, log: quiet }).locate('spotdl')).toBe(join(toolsDir, binaryName('spotdl')));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, binaryName('spotdl')), 'x');
    expect(new HubTools({ toolsDir: join(root, 'none'), imagePaths: {}, env: { PATH: bin }, log: quiet }).locate('spotdl')).toBe(join(bin, binaryName('spotdl')));
  });

  it('prefers the copy the image shipped', () => {
    const shipped = join(root, 'shipped-yt-dlp');
    writeFileSync(shipped, 'x');
    const tools = new HubTools({ toolsDir: join(root, 'tools'), imagePaths: { 'yt-dlp': shipped }, env: { PATH: '' }, log: quiet });
    expect(tools.locate('yt-dlp')).toBe(shipped);
  });

  it('sets up what is missing, once, and tells whoever needs to know', async () => {
    const toolsDir = join(root, 'tools');
    const asked: string[] = [];
    const landed: string[] = [];
    const tools = new HubTools({
      toolsDir,
      imagePaths: {},
      env: { PATH: '' },
      log: quiet,
      platform: 'win32',
      onInstalled: (id) => landed.push(id),
      install: async (id, options) => {
        asked.push(id);
        mkdirSync(options.toolsDir, { recursive: true });
        writeFileSync(join(options.toolsDir, binaryName(id, 'win32')), 'x');
        return { installed: true, version: '1', reason: null };
      },
    });
    await tools.ensure();
    expect(asked).toEqual(['yt-dlp', 'ffmpeg', 'spotdl']);
    expect(landed).toEqual(['yt-dlp', 'ffmpeg', 'spotdl']);
    expect(tools.status()).toEqual({ 'yt-dlp': { present: true, reason: null }, ffmpeg: { present: true, reason: null }, spotdl: { present: true, reason: null } });
    await tools.ensure();
    expect(asked, 'present tools are left alone').toEqual(['yt-dlp', 'ffmpeg', 'spotdl']);
  });

  it('does not fetch FFmpeg where the system package is the right copy', async () => {
    const asked: string[] = [];
    const tools = new HubTools({
      toolsDir: join(root, 'tools'),
      imagePaths: {},
      env: { PATH: '' },
      log: quiet,
      platform: 'linux',
      install: async (id) => {
        asked.push(id);
        return { installed: false, version: null, reason: 'no network' };
      },
    });
    await tools.ensure();
    expect(asked).toEqual(['yt-dlp', 'spotdl']);
    expect(tools.status()['yt-dlp']).toEqual({ present: false, reason: 'no network' });
    expect(tools.status().spotdl).toEqual({ present: false, reason: 'no network' });
  });

  it('treats a failed setup as a reason, not a crash', async () => {
    const tools = new HubTools({
      toolsDir: join(root, 'tools'),
      imagePaths: {},
      env: { PATH: '' },
      log: quiet,
      platform: 'linux',
      install: async () => {
        throw new Error('offline');
      },
    });
    await expect(tools.ensure()).resolves.toBeUndefined();
    expect(tools.status()['yt-dlp']).toEqual({ present: false, reason: 'offline' });
  });

  it('sets nothing up for a hub with no disk', async () => {
    const none = new HubTools({
      toolsDir: null,
      imagePaths: {},
      env: { PATH: '' },
      log: quiet,
      install: async () => {
        throw new Error('must not run');
      },
    });
    await expect(none.ensure()).resolves.toBeUndefined();
  });
});
