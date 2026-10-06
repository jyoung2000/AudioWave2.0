/**
 * The external tool is the most dangerous provider in the hub: it is the only one that starts a
 * process. So the presets that make it usable are pinned here rather than trusted to review.
 *
 * Two properties matter more than the rest. Nothing a user typed may reach the command line as a
 * flag — the URL is always the last argument, behind `--` — and the tool must not read a
 * configuration file: yt-dlp is told `--ignore-config` first, because a `yt-dlp.conf` left in the
 * container's home directory can add `--exec`; spotDL, which has no such flag, gets a new, empty
 * home directory on every run.
 */
import { describe, expect, it } from 'vitest';
import { ExternalToolAdapter, TOOL_PRESETS, type DownloadArgsContext } from '../../src/providers/adapters/external-tool.js';

function adapter(extra: Record<string, string>, locate: (tool: 'yt-dlp' | 'spotdl') => string | null = () => null): ExternalToolAdapter {
  const instance = new ExternalToolAdapter(locate);
  instance.configure({ enabled: true, clientId: null, clientSecret: null, apiKey: null, applicationId: null, redirectUri: null, contactEmail: null, extra });
  return instance;
}

/** A link written to be read as flags, if anything were careless enough to let it. */
const HOSTILE = 'https://www.youtube.com/watch?v=x&--exec=rm%20-rf%20/';
const ctx = (url = HOSTILE, ffmpeg: string | null = '/usr/bin/ffmpeg'): DownloadArgsContext => ({ url, outputDir: '/data/partial/job.d', ffmpeg, node: '/usr/local/bin/node' });

describe('the yt-dlp preset', () => {
  const preset = TOOL_PRESETS['yt-dlp'];
  const args = preset.download(ctx());

  it('tells the tool to ignore configuration files, first — for downloads and for reading links', () => {
    expect(args[0]).toBe('--ignore-config');
    expect(preset.metadata({ url: HOSTILE, ffmpeg: null, node: null, saveFile: '', listLimit: 201 })![0]).toBe('--ignore-config');
  });

  it('puts the URL last and behind a separator, so nothing in it reads as a flag', () => {
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe(HOSTILE);
    expect(args.filter((a) => a.includes('--exec'))).toEqual([HOSTILE]);
    const metadata = preset.metadata({ url: HOSTILE, ffmpeg: null, node: null, saveFile: '', listLimit: 201 })!;
    expect(metadata.slice(-2)).toEqual(['--', HOSTILE]);
  });

  it('writes into the job’s own directory, and nowhere it chooses', () => {
    const output = args[args.indexOf('--output') + 1]!;
    expect(output.replaceAll('\\', '/')).toBe('/data/partial/job.d/media.%(ext)s');
  });

  it('tags the file and embeds its cover, converted to JPEG, with the hub’s FFmpeg', () => {
    expect(args).toEqual(expect.arrayContaining(['--extract-audio', '--embed-metadata', '--embed-thumbnail', '--write-info-json']));
    expect(args[args.indexOf('--convert-thumbnails') + 1]).toBe('jpg');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/usr/bin/ffmpeg');
  });

  it('without FFmpeg saves the file as it came, rather than failing on steps it cannot do', () => {
    const bare = preset.download(ctx(HOSTILE, null));
    expect(bare).not.toContain('--extract-audio');
    expect(bare).not.toContain('--embed-thumbnail');
    expect(bare).not.toContain('--ffmpeg-location');
    expect(bare.slice(-2)).toEqual(['--', HOSTILE]);
  });

  it('runs YouTube’s player script with this Node, not a runtime it would fetch', () => {
    expect(args[args.indexOf('--js-runtimes') + 1]).toBe('node:/usr/local/bin/node');
  });

  it('takes one track per job; reading a link lists at most one more entry than a batch takes', () => {
    expect(args).toContain('--no-playlist');
    const metadata = preset.metadata({ url: HOSTILE, ffmpeg: null, node: null, saveFile: '', listLimit: 201 })!;
    expect(metadata).toEqual(expect.arrayContaining(['--dump-single-json', '--no-download', '--flat-playlist']));
    expect(metadata[metadata.indexOf('--playlist-end') + 1]).toBe('201');
  });

  it('never offers to carry credentials', () => {
    const flags = [...preset.download(ctx('https://youtu.be/x')), ...preset.metadata({ url: 'https://youtu.be/x', ffmpeg: null, node: null, saveFile: '', listLimit: 2 })!].join(' ');
    expect(flags).not.toMatch(/--cookies|--exec|--netrc|--username|--password/);
  });
});

describe('reading a whole list for the catalog (no 200-song cap)', () => {
  const preset = TOOL_PRESETS['yt-dlp'];
  const url = 'https://soundcloud.com/band/sets/long';
  it('lists flat up to the limit it is given, and describes a page of positions in full', () => {
    const flat = preset.metadata({ url, ffmpeg: null, node: null, saveFile: '', listLimit: 10_001 })!;
    expect(flat[flat.indexOf('--playlist-end') + 1]).toBe('10001');
    const page = preset.metadata({ url, ffmpeg: null, node: null, saveFile: '', listLimit: 10_001, items: [201, 202, 203] })!;
    expect(page[page.indexOf('--playlist-items') + 1]).toBe('201,202,203');
    expect(page).not.toContain('--flat-playlist');
    expect(page.slice(-2)).toEqual(['--', url]);
  });
});

describe('the spotDL preset', () => {
  const preset = TOOL_PRESETS.spotdl;
  const url = 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8';
  const args = preset.download(ctx(url));

  it('takes only open.spotify.com links', () => {
    expect(preset.allowedHosts).toEqual(['open.spotify.com']);
  });

  it('downloads the one link it is given, straight after the operation and never behind `--` (spotDL 4.5.2 refuses it)', () => {
    expect(args.slice(0, 2)).toEqual(['download', url]);
    expect(args).not.toContain('--');
    expect(args.filter((a) => a === url)).toHaveLength(1);
  });

  it('hands spotDL only an http(s) address, so a link can never be read as a flag', () => {
    expect(() => preset.download(ctx('--exec=calc'))).toThrow(/http\(s\)/);
    expect(() => preset.metadata({ url: '-o/etc/passwd', ffmpeg: '/usr/bin/ffmpeg', node: null, saveFile: '/tmp/x/save.spotdl', listLimit: 201 })).toThrow(/http\(s\)/);
  });

  it('names its file inside the job’s directory and writes what it knew beside it', () => {
    expect(args[args.indexOf('--output') + 1]!.replaceAll('\\', '/')).toBe('/data/partial/job.d/{track-id}.{output-ext}');
    expect(args[args.indexOf('--save-file') + 1]!.replaceAll('\\', '/')).toBe('/data/partial/job.d/song.spotdl');
    expect(preset.infoFile).toBe('song.spotdl');
  });

  it('uses the hub’s FFmpeg, keeps no cache, and gets a home of its own every run', () => {
    expect(args[args.indexOf('--ffmpeg') + 1]).toBe('/usr/bin/ffmpeg');
    expect(args).toContain('--no-cache');
    expect(preset.needsHome).toBe(true);
    expect(args.join(' ')).not.toMatch(/--config|--cookie-file|--user-auth|--client-secret|--auth-token/);
  });

  it('reads a link with `save`, and refuses to try without FFmpeg (spotDL will not start without it)', () => {
    const save = preset.metadata({ url, ffmpeg: '/usr/bin/ffmpeg', node: null, saveFile: '/tmp/x/save.spotdl', listLimit: 201 })!;
    expect(save.slice(0, 2)).toEqual(['save', url]);
    expect(save).not.toContain('--');
    expect(preset.metadata({ url, ffmpeg: null, node: null, saveFile: '/tmp/x/save.spotdl', listLimit: 201 })).toBeNull();
  });
});

describe('choosing a preset', () => {
  it('needs no setup at all: with nothing configured, yt-dlp and spotDL are the tools', () => {
    const instance = adapter({});
    expect(instance.presets().map((p) => p.tool)).toEqual(['yt-dlp', 'spotdl']);
    expect(instance.preset()?.displayName).toBe('yt-dlp');
    expect(instance.requiredConfig()).toEqual([]);
    expect(instance.allowedHosts()).toEqual(expect.arrayContaining(['soundcloud.com', 'music.youtube.com', 'open.spotify.com']));
  });

  it('sends a Spotify link to spotDL and everything else to yt-dlp', () => {
    const instance = adapter({});
    expect(instance.presetFor(new URL('https://open.spotify.com/track/x'))?.tool).toBe('spotdl');
    expect(instance.presetFor(new URL('https://youtu.be/x'))?.tool).toBe('yt-dlp');
  });

  it('a named preset is that tool alone, with its own hosts', () => {
    const instance = adapter({ preset: 'yt-dlp' });
    expect(instance.presets().map((p) => p.tool)).toEqual(['yt-dlp']);
    expect(instance.allowedHosts()).not.toContain('open.spotify.com');
    expect(instance.commandTemplate()[0]).toBe('/usr/local/bin/yt-dlp');
  });

  it('runs the copies the hub found or set up for itself, unless an operator named another', () => {
    const locate = (id: 'yt-dlp' | 'spotdl'): string => `/data/tools/${id}`;
    expect(adapter({}, locate).commandTemplate()[0]).toBe('/data/tools/yt-dlp');
    expect(adapter({}, locate).binaryFor(TOOL_PRESETS.spotdl)).toBe('/data/tools/spotdl');
    expect(adapter({ binary: '/opt/yt-dlp' }, locate).commandTemplate()[0]).toBe('/opt/yt-dlp');
    // A named binary is the first tool's; it never stands in for spotDL.
    expect(adapter({ binary: '/opt/yt-dlp' }, locate).binaryFor(TOOL_PRESETS.spotdl)).toBe('/data/tools/spotdl');
  });

  it('lets an operator add hosts but never quietly lose the presets’ own', () => {
    const instance = adapter({ allowedHosts: 'example.org' });
    expect(instance.allowedHosts()).toContain('example.org');
    expect(instance.allowedHosts()).toContain('youtu.be');
    expect(instance.allowedHosts()).toContain('open.spotify.com');
  });

  it('falls back to a hand-written template, and asks for both halves of it', () => {
    const instance = adapter({ command: '/usr/bin/mytool -o {output} {url}', allowedHosts: 'example.org' });
    expect(instance.requiredConfig()).toEqual(['command', 'allowedHosts']);
    expect(instance.commandTemplate()).toEqual(['/usr/bin/mytool', '-o', '{output}', '{url}']);
    expect(instance.allowedHosts()).toEqual(['example.org']);
  });

  it('fills a template’s {output} and {url} as data: the URL only as a whole argument, never spliced', () => {
    const instance = adapter({ command: '/usr/bin/mytool -o {output} --page={url} {url}', allowedHosts: 'example.org' });
    const plan = instance.downloadPlan('https://example.org/a$&b', { outputDir: '/d', output: '/d/job.part', ffmpeg: null });
    expect(plan.mode).toBe('file');
    expect(plan.args).toEqual(['-o', '/d/job.part', '--page={url}', 'https://example.org/a$&b']);
  });

  it('treats an unknown preset name as no preset, rather than as a command it invented', () => {
    const instance = adapter({ preset: 'something-else' });
    expect(instance.preset()).toBeNull();
    expect(instance.commandTemplate()).toEqual([]);
    expect(instance.requiredConfig()).toEqual(['command', 'allowedHosts']);
  });

  it('will not plan a Spotify download without spotDL or without FFmpeg', () => {
    expect(() => adapter({}, () => null).downloadPlan('https://open.spotify.com/track/x', { outputDir: '/d', output: '/d/p', ffmpeg: '/usr/bin/ffmpeg' })).toThrow(/spotDL is not on this hub/);
    expect(() => adapter({}, () => process.execPath).downloadPlan('https://open.spotify.com/track/x', { outputDir: '/d', output: '/d/p', ffmpeg: null })).toThrow(/needs FFmpeg/);
  });
});

describe('what it reports', () => {
  it('names the tools that are on this hub in the Providers row', () => {
    expect(adapter({}, (id) => (id === 'spotdl' ? process.execPath : null)).descriptor().displayName).toBe('External media tool (yt-dlp, spotDL)');
    const without = adapter({}, () => null).descriptor();
    expect(without.displayName).toBe('External media tool (yt-dlp)');
    expect(without.limitations.join(' ')).toMatch(/spotDL is not on this hub yet/);
  });

  it('refuses to call a missing binary present', async () => {
    const result = await adapter({ preset: 'yt-dlp', binary: '/nope/yt-dlp' }).test();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it('says the tool is still on its way when it is not on this machine yet', async () => {
    const result = await adapter({}, () => '/nope/yt-dlp').test();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
    expect(result.message).toMatch(/sets it up/i);
  });

  it('says what is wrong when a template was started and not finished', async () => {
    const result = await adapter({ preset: 'something-else' }).test();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no command/i);
  });

  it('reports the version a real binary gives, because an old yt-dlp fails confusingly', async () => {
    // `node --version` stands in: the adapter's claim is "it answered, and here is what it said".
    const result = await adapter({ preset: 'yt-dlp', binary: process.execPath }).test();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^v\d+/);
    expect(result.message).toMatch(/host\(s\) allowlisted/);
  });

  it('takes a Bandcamp artist’s own page, and not a look-alike host', async () => {
    const instance = adapter({ preset: 'yt-dlp' });
    expect(await instance.getAuthorizedDownload('https://someartist.bandcamp.com/track/a-song', { basis: 'purchased-export', actorId: 'device' })).not.toBeNull();
    expect(await instance.getAuthorizedDownload('https://evilbandcamp.com/track/a-song', { basis: 'purchased-export', actorId: 'device' })).toBeNull();
    expect(await instance.getAuthorizedDownload('https://bandcamp.com.evil.example/track/a-song', { basis: 'purchased-export', actorId: 'device' })).toBeNull();
  });

  it('stays unavailable for a download with no rights basis', async () => {
    const instance = adapter({ preset: 'yt-dlp' });
    const authorized = await instance.getAuthorizedDownload('https://music.youtube.com/watch?v=x', { basis: 'hub-hosted', actorId: 'device' });
    expect(authorized).toBeNull();
  });
});
