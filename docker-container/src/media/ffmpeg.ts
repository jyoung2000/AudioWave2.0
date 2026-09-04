/**
 * FFmpeg discovery.
 *
 * The hub reports what the *installed* binary can actually do rather than assuming a build. Its
 * encoder list is what `GET /downloads/formats` turns into per-format availability, so a hub whose
 * FFmpeg lacks libmp3lame says "this build has no libmp3lame encoder" instead of offering MP3 and
 * failing halfway through a job.
 *
 * A missing FFmpeg is not an error: `original` (a byte-for-byte copy) still works, and only the
 * conversion formats become unavailable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FfmpegInfo } from '../deps.js';

const run = promisify(execFile);

const UNAVAILABLE: FfmpegInfo = { available: false, path: null, version: null, encoders: [] };

/** Encoders the hub asks about; anything else in the build is irrelevant here. */
const AUDIO_ENCODERS = ['libmp3lame', 'aac', 'libopus', 'libvorbis', 'flac', 'alac', 'pcm_s16le'] as const;

export async function detectFfmpeg(configuredPath: string | null): Promise<FfmpegInfo> {
  const candidates = configuredPath ? [configuredPath] : ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const path of candidates) {
    try {
      // `shell: false` is the default for execFile; no argument here is ever user-supplied.
      const { stdout } = await run(path, ['-hide_banner', '-version'], { timeout: 5_000, maxBuffer: 1024 * 1024 });
      const version = /^ffmpeg version (\S+)/m.exec(stdout)?.[1] ?? null;
      const encoders = await detectEncoders(path);
      return { available: true, path, version, encoders };
    } catch {
      // Try the next candidate; an absent binary is the normal case on a minimal host.
    }
  }
  return UNAVAILABLE;
}

async function detectEncoders(path: string): Promise<string[]> {
  try {
    const { stdout } = await run(path, ['-hide_banner', '-encoders'], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    return AUDIO_ENCODERS.filter((name) => new RegExp(`^\\s*\\S*A\\S*\\s+${name}\\s`, 'm').test(stdout));
  } catch {
    return [];
  }
}
