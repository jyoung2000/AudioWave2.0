/**
 * The hub calls its downloader working only when it really runs (Hermes, 2026-10-04).
 *
 * The container shipped a yt-dlp that existed and could not start: it unpacks itself into `$TMPDIR`,
 * and the container's `/tmp` is a small `noexec` tmpfs. The provider list still said "ok", because
 * nothing ever ran it. These tests run stand-in tools (Node scripts, which `versionOf` starts with
 * this Node) in the environment the download service uses.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolEnvironment, toolScratchDir } from '../../src/media/tool-env.js';
import { ExternalToolAdapter } from '../../src/providers/adapters/external-tool.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'np-tool-runs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function adapter(binary: string, env: NodeJS.ProcessEnv): ExternalToolAdapter {
  const instance = new ExternalToolAdapter(() => binary, () => env);
  instance.configure({ enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra: {} });
  return instance;
}

describe('the tool environment', () => {
  it('gives the tool its own scratch folder on the data volume, and nothing else of the hub’s', () => {
    const scratch = toolScratchDir(root)!;
    expect(scratch).toBe(join(root, 'tmp', 'tools'));
    const env = toolEnvironment(scratch, { PATH: '/usr/bin', NP_DISCORD_TOKEN: 'secret', HOME: '/home/node' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', TMPDIR: scratch });
  });

  it('on Windows also points TEMP and TMP there, and keeps SystemRoot', () => {
    const env = toolEnvironment('D:/data/tmp/tools', { Path: 'C:/Windows', SystemRoot: 'C:/Windows', TEMP: 'C:/t' }, 'win32');
    expect(env).toEqual({ PATH: 'C:/Windows', SystemRoot: 'C:/Windows', TEMP: 'D:/data/tmp/tools', TMP: 'D:/data/tmp/tools', TMPDIR: 'D:/data/tmp/tools' });
  });

  it('a hub with no disk leaves the default in place', () => {
    expect(toolScratchDir(':memory:')).toBeNull();
    expect(toolEnvironment(null, { PATH: '/bin' }, 'linux')).toEqual({ PATH: '/bin' });
  });
});

describe('external tool health', () => {
  it('a tool that exists and will not start is down, with a reason a person can act on', async () => {
    const broken = join(root, 'yt-dlp.mjs');
    writeFileSync(broken, "process.stderr.write('[PYI-68:ERROR] Failed to extract\\n'); process.exit(255);\n");
    const instance = adapter(broken, toolEnvironment(toolScratchDir(root), process.env));
    const health = await instance.health();
    expect(health.status).toBe('down');
    expect(health.lastError).toMatch(/would not start/);
    expect((await instance.test()).ok).toBe(false);
  });

  it('a tool that starts is ok — and is asked in the environment downloads use', async () => {
    const tool = join(root, 'yt-dlp.mjs');
    // Answers --version with where it was told to unpack itself.
    writeFileSync(tool, 'console.log(process.env.TMPDIR ?? "no TMPDIR");\n');
    const scratch = toolScratchDir(root)!;
    const instance = adapter(tool, toolEnvironment(scratch, process.env));
    expect((await instance.health()).status).toBe('ok');
    const tested = await instance.test();
    expect(tested.ok).toBe(true);
    expect(tested.message.startsWith(scratch)).toBe(true);
  });

  it('a tool that is not there yet is unconfigured, not down', async () => {
    const instance = adapter(join(root, 'missing-yt-dlp'), {});
    expect((await instance.health()).status).toBe('unconfigured');
  });
});
