/**
 * The parts of the helper worth pinning are the ones where being wrong is dangerous rather than
 * merely broken: the command line it builds, the environment it hands a subprocess, which origins
 * it answers, and which paths it will serve. Each of those is a plain function so it can be asserted
 * without a socket.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { childEnv, lastMeaningfulLine, spotdlArgs, ytDlpArgs } from '../../src/jobs.js';
import { findOnPath, digestFor, ytDlpAsset } from '../../src/tools.js';
import { originAllowed, tokenMatches, checkFetchUrl } from '../../src/security.js';
import { withToken, withinRoot } from '../../src/app.js';
import { pickTool } from '../../src/server.js';
import { dataDir, parseArgs } from '../../src/options.js';
import { HELPER_DEFAULT_HOSTS, HELPER_TOKEN_META } from '@now-playing/contracts';

const job = (format: 'original' | 'flac' = 'original') => ({ url: 'https://www.youtube.com/watch?v=abc', format }) as const;

describe('the command line it builds', () => {
  it('always tells the tool to ignore configuration files', () => {
    // Not a nicety: a yt-dlp.conf in the user's home can add --exec, and a web page must not be
    // able to reach that even by accident.
    expect(ytDlpArgs(job(), '/tmp/j', { present: true, path: '/usr/bin/ffmpeg' })[0]).toBe('--ignore-config');
  });

  it('never passes anything the caller wrote except the URL', () => {
    const args = ytDlpArgs({ url: 'https://www.youtube.com/watch?v=a&b=--exec', format: 'original' }, '/tmp/j', { present: true });
    // The URL is last and behind `--`, so nothing in it can be read as a flag.
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=a&b=--exec');
    expect(args.filter((a) => a.startsWith('--exec'))).toEqual([]);
  });

  it('extracts audio when FFmpeg is there and asks for one audio stream when it is not', () => {
    expect(ytDlpArgs(job(), '/tmp/j', { present: true })).toContain('--extract-audio');
    const without = ytDlpArgs(job(), '/tmp/j', { present: false });
    expect(without).not.toContain('--extract-audio');
    expect(without).toContain('bestaudio/best');
  });

  it('only names an output format when one was asked for', () => {
    expect(ytDlpArgs(job('original'), '/tmp/j', { present: true })).not.toContain('--audio-format');
    const flac = ytDlpArgs(job('flac'), '/tmp/j', { present: true });
    expect(flac[flac.indexOf('--audio-format') + 1]).toBe('flac');
  });

  it('caps a playlist, so one pasted link is not a thousand files', () => {
    const args = ytDlpArgs(job(), '/tmp/j', { present: true });
    expect(args[args.indexOf('--playlist-end') + 1]).toBe('200');
  });

  it('gives spotDL mp3 when asked for the original, because it has no original to give', () => {
    // It reads Spotify for the track list and fetches the audio from elsewhere, so there is no
    // source file to preserve — "original" would be a word with nothing behind it.
    const args = spotdlArgs({ url: 'https://open.spotify.com/track/x', format: 'original' }, '/tmp/j', { present: true });
    expect(args[args.indexOf('--format') + 1]).toBe('mp3');
  });
});

describe('the environment a tool is given', () => {
  it('keeps what a program needs to run and drops what identifies the person running it', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/home/me', AWS_SECRET_ACCESS_KEY: 'shh', SPOTIFY_TOKEN: 'shh', LANG: 'en_GB.UTF-8' });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['LANG']).toBe('en_GB.UTF-8');
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['SPOTIFY_TOKEN']).toBeUndefined();
  });
});

describe('which origins it answers', () => {
  const policy = { allowed: ['https://example.github.io'], self: 'http://127.0.0.1:17342' };

  it('answers its own page and the origins it was told about', () => {
    expect(originAllowed(policy, 'http://127.0.0.1:17342')).toBe(true);
    expect(originAllowed(policy, 'https://example.github.io')).toBe(true);
  });

  it('answers a request with no origin, which is the app reading on its own origin', () => {
    expect(originAllowed(policy, undefined)).toBe(true);
  });

  it('refuses everything else, including an opaque origin', () => {
    expect(originAllowed(policy, 'https://evil.example')).toBe(false);
    expect(originAllowed(policy, 'null')).toBe(false);
    expect(originAllowed(policy, '')).toBe(false);
    // A near miss is still a miss: a different port is a different origin.
    expect(originAllowed(policy, 'http://127.0.0.1:17343')).toBe(false);
  });
});

describe('the token', () => {
  it('matches itself and nothing else', () => {
    expect(tokenMatches('abc123', 'abc123')).toBe(true);
    expect(tokenMatches('abc123', 'abc124')).toBe(false);
    expect(tokenMatches('abc123', undefined)).toBe(false);
    // A prefix must not pass, and comparing different lengths must not throw.
    expect(tokenMatches('abc123', 'abc')).toBe(false);
  });

  it('goes into the document where the page can read it', () => {
    const html = withToken('<!doctype html><html><head><title>x</title></head><body></body></html>', 'tok');
    expect(html).toContain(`<meta name="${HELPER_TOKEN_META}" content="tok">`);
    // Inside the head, before anything that might run.
    expect(html.indexOf('content="tok"')).toBeLessThan(html.indexOf('<title>'));
  });
});

describe('the URLs it will fetch', () => {
  it('takes the hosts it ships with', () => {
    expect(checkFetchUrl('https://music.youtube.com/watch?v=x', HELPER_DEFAULT_HOSTS).ok).toBe(true);
    expect(checkFetchUrl('https://open.spotify.com/track/x', HELPER_DEFAULT_HOSTS).ok).toBe(true);
  });

  it('refuses anything else, including this machine', () => {
    expect(checkFetchUrl('https://evil.example/x', HELPER_DEFAULT_HOSTS).ok).toBe(false);
    // The one that matters: this program runs inside someone's network.
    expect(checkFetchUrl('https://127.0.0.1/x', HELPER_DEFAULT_HOSTS).ok).toBe(false);
    expect(checkFetchUrl('https://192.168.1.10/x', HELPER_DEFAULT_HOSTS).ok).toBe(false);
    expect(checkFetchUrl('http://www.youtube.com/x', HELPER_DEFAULT_HOSTS).ok).toBe(false);
    expect(checkFetchUrl('https://user:pass@www.youtube.com/x', HELPER_DEFAULT_HOSTS).ok).toBe(false);
  });
});

describe('the files it will serve', () => {
  const root = resolve('/srv/app');

  it('serves what is under the root', () => {
    expect(withinRoot(root, '/assets/index.js')).toBe(resolve(root, 'assets/index.js'));
  });

  it('refuses to climb out of it, however the path is spelled', () => {
    expect(withinRoot(root, '/../../etc/passwd')).toBeNull();
    expect(withinRoot(root, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(withinRoot(root, '/assets/../../etc/passwd')).toBeNull();
    expect(withinRoot(root, '/x%00.js')).toBeNull();
  });
});

describe('picking a tool', () => {
  it('sends Spotify links to spotDL and everything else to yt-dlp', () => {
    expect(pickTool('auto', new URL('https://open.spotify.com/track/x'))).toBe('spotdl');
    expect(pickTool('auto', new URL('https://music.youtube.com/watch?v=x'))).toBe('yt-dlp');
    expect(pickTool('auto', new URL('https://soundcloud.com/a/b'))).toBe('yt-dlp');
  });

  it('does not match a lookalike host', () => {
    expect(pickTool('auto', new URL('https://open.spotify.com.evil.example/x'))).toBe('yt-dlp');
  });

  it('obeys a tool named outright', () => {
    expect(pickTool('yt-dlp', new URL('https://open.spotify.com/track/x'))).toBe('yt-dlp');
  });
});

describe('finding the tools', () => {
  it('walks PATH by hand rather than shelling out', () => {
    // `node` is on PATH wherever these tests run, so it stands in for a tool.
    const binary = process.platform === 'win32' ? 'node.exe' : 'node';
    expect(findOnPath(binary)).toBeTruthy();
    expect(findOnPath('definitely-not-a-real-binary-93bc')).toBeNull();
  });

  it('knows which asset a platform gets, and admits when there is none', () => {
    expect(ytDlpAsset('linux', 'x64')).toBe('yt-dlp_linux');
    expect(ytDlpAsset('linux', 'arm64')).toBe('yt-dlp_linux_aarch64');
    expect(ytDlpAsset('darwin', 'arm64')).toBe('yt-dlp_macos');
    expect(ytDlpAsset('win32', 'x64')).toBe('yt-dlp.exe');
    expect(ytDlpAsset('freebsd', 'x64')).toBeNull();
  });

  it('reads a checksum only for the exact asset it asked about', () => {
    const sums = ['aaaa'.repeat(16) + '  yt-dlp_linux', 'bbbb'.repeat(16) + '  yt-dlp_linux_aarch64'].join('\n');
    expect(digestFor(sums, 'yt-dlp_linux')).toBe('aaaa'.repeat(16));
    expect(digestFor(sums, 'yt-dlp_linux_aarch64')).toBe('bbbb'.repeat(16));
    // A name that is not published gets nothing, rather than the nearest line.
    expect(digestFor(sums, 'yt-dlp.exe')).toBeNull();
  });
});

describe('the command line the helper itself takes', () => {
  it('needs no arguments to be useful', () => {
    const options = parseArgs([]);
    expect(options.serveApp).toBe(true);
    expect(options.open).toBe(true);
    expect(options.allowedHosts).toEqual([...HELPER_DEFAULT_HOSTS]);
    expect(options.allowedOrigins).toEqual([]);
  });

  it('reduces an allowed origin to an origin', () => {
    expect(parseArgs(['--allow-origin', 'https://example.github.io/player/']).allowedOrigins).toEqual(['https://example.github.io']);
  });

  it('replaces the host list once and adds to it after', () => {
    expect(parseArgs(['--only-hosts', 'archive.org']).allowedHosts).toEqual(['archive.org']);
    expect(parseArgs(['--only-hosts', 'archive.org', '--only-hosts', 'example.com']).allowedHosts).toEqual(['archive.org', 'example.com']);
  });

  it('refuses what it cannot make sense of, by name', () => {
    expect(() => parseArgs(['--port'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--port', '0'])).toThrow(/not a port/);
    expect(() => parseArgs(['--allow-host', 'not a host'])).toThrow(/not a hostname/);
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/);
  });

  it('keeps an installed tool where that platform keeps such things', () => {
    expect(dataDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32')).toContain('NowPlaying');
    expect(dataDir({ XDG_DATA_HOME: '/home/me/.local/share' }, 'linux')).toBe('/home/me/.local/share/now-playing');
  });
});

describe('reporting a failure', () => {
  it('quotes the line that says what went wrong, not the warnings above it', () => {
    const stderr = ['WARNING: [youtube] Falling back', 'WARNING: something else', 'ERROR: Video unavailable'].join('\n');
    expect(lastMeaningfulLine(stderr)).toBe('Video unavailable');
  });

  it('says nothing when there is nothing to say', () => {
    expect(lastMeaningfulLine('WARNING: only a warning\n')).toBeNull();
    expect(lastMeaningfulLine('')).toBeNull();
  });
});
