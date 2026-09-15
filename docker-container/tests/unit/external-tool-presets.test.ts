/**
 * The external tool is the most dangerous provider in the hub: it is the only one that starts a
 * process. So the preset that makes it usable is pinned here rather than trusted to review.
 *
 * Two properties matter more than the rest. Nothing a user typed may reach the command line as a
 * flag, and the tool must be told to ignore configuration files — because a `yt-dlp.conf` left in
 * the container's home directory can add `--exec`, which would turn "download this" into "run this".
 */
import { describe, expect, it } from 'vitest';
import { ExternalToolAdapter, TOOL_PRESETS } from '../../src/providers/adapters/external-tool.js';

function adapter(extra: Record<string, string>): ExternalToolAdapter {
  const instance = new ExternalToolAdapter();
  instance.configure({ enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra });
  return instance;
}

describe('the yt-dlp preset', () => {
  const preset = TOOL_PRESETS['yt-dlp']!;

  it('tells the tool to ignore configuration files, first', () => {
    expect(preset.args[0]).toBe('--ignore-config');
  });

  it('puts the URL last and behind a separator, so nothing in it reads as a flag', () => {
    expect(preset.args.at(-2)).toBe('--');
    expect(preset.args.at(-1)).toBe('{url}');
  });

  it('writes exactly where the hub told it to', () => {
    // No --extract-audio: yt-dlp's extractor renames the file it was given, and a hub download job
    // names one path. The hub's own FFmpeg step does the converting.
    expect(preset.args).toContain('{output}');
    expect(preset.args).not.toContain('--extract-audio');
    expect(preset.args).not.toContain('-x');
  });

  it('takes one track, because that is what a download job is', () => {
    expect(preset.args).toContain('--no-playlist');
  });

  it('never offers to carry credentials', () => {
    const flags = preset.args.join(' ');
    expect(flags).not.toMatch(/--cookies/);
    expect(flags).not.toMatch(/--exec/);
    expect(flags).not.toMatch(/--netrc/);
  });

  it('has no spotDL companion, and that is deliberate', () => {
    // spotDL turns one link into a set of tracks and wants a directory; a hub job is one path.
    // The local helper gives each job its own directory, so spotDL belongs there instead.
    expect(Object.keys(TOOL_PRESETS)).toEqual(['yt-dlp']);
  });
});

describe('choosing a preset', () => {
  it('fills in both the command and the hosts, so nothing else is required', () => {
    const instance = adapter({ preset: 'yt-dlp' });
    expect(instance.requiredConfig()).toEqual(['preset']);
    expect(instance.commandTemplate()[0]).toBe('/usr/local/bin/yt-dlp');
    expect(instance.allowedHosts()).toContain('music.youtube.com');
  });

  it('lets an operator add hosts but never quietly lose the preset’s own', () => {
    const instance = adapter({ preset: 'yt-dlp', allowedHosts: 'example.org' });
    expect(instance.allowedHosts()).toContain('example.org');
    expect(instance.allowedHosts()).toContain('youtu.be');
  });

  it('lets an operator point at a different binary without rewriting the command line', () => {
    expect(adapter({ preset: 'yt-dlp', binary: '/opt/yt-dlp' }).commandTemplate()[0]).toBe('/opt/yt-dlp');
  });

  it('falls back to a hand-written template, and asks for both halves of it', () => {
    const instance = adapter({ command: '/usr/bin/mytool -o {output} {url}', allowedHosts: 'example.org' });
    expect(instance.requiredConfig()).toEqual(['command', 'allowedHosts']);
    expect(instance.commandTemplate()).toEqual(['/usr/bin/mytool', '-o', '{output}', '{url}']);
    expect(instance.allowedHosts()).toEqual(['example.org']);
  });

  it('treats an unknown preset name as no preset, rather than as a command it invented', () => {
    const instance = adapter({ preset: 'something-else' });
    expect(instance.preset()).toBeNull();
    expect(instance.commandTemplate()).toEqual([]);
    expect(instance.requiredConfig()).toEqual(['command', 'allowedHosts']);
  });
});

describe('what it reports', () => {
  it('refuses to call a missing binary present', async () => {
    const result = await adapter({ preset: 'yt-dlp', binary: '/nope/yt-dlp' }).test();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('says what is wrong when nothing is configured at all', async () => {
    const result = await adapter({}).test();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no preset/i);
  });

  it('reports the version a real binary gives, because an old yt-dlp fails confusingly', async () => {
    // `node --version` stands in: the adapter's claim is "it answered, and here is what it said".
    const result = await adapter({ preset: 'yt-dlp', binary: process.execPath }).test();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^v\d+/);
    expect(result.message).toMatch(/host\(s\) allowlisted/);
  });

  it('stays unavailable for a download with no rights basis', async () => {
    const instance = adapter({ preset: 'yt-dlp' });
    const authorized = await instance.getAuthorizedDownload('https://music.youtube.com/watch?v=x', { basis: 'hub-hosted', actorId: 'device' });
    expect(authorized).toBeNull();
  });
});
