// The estimator alone: the package root pulls in Web Audio types the hub does not have and does not need.
import { estimateTempo, type TempoEstimate } from '@now-playing/audio-core/tempo';
import { spawn } from 'node:child_process';
import type { Logger } from 'pino';
import type { FfmpegInfo } from '../deps.js';
import type { SafeHttpClient } from '../providers/http.js';

/**
 * A tempo for a song nobody has downloaded: the 30-second clip the listing plays, decoded in memory
 * and discarded. Only the platforms' preview hosts, only up to four megabytes, only when ffmpeg is
 * there to decode it. No clip is written to disk, and no audio host outside this list is ever asked.
 */
export const PREVIEW_HOSTS = ['audio-ssl.itunes.apple.com', 'p.scdn.co', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com'] as const;
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
const SAMPLE_RATE = 22050;
const CLIP_SECONDS = 30;
const DECODE_TIMEOUT_MS = 20_000;
/** More PCM than 40 s of mono 16-bit at the sample rate means the decoder is not doing what it was told. */
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 40;

export interface PreviewBpmDeps {
  http: SafeHttpClient;
  ffmpeg: () => Promise<FfmpegInfo>;
  log: Logger;
  /** Test seam: spawn the ffmpeg binary with these arguments instead of the decode arguments. */
  ffmpegArgsOverride?: string[];
}

export async function bpmFromPreviewClip(deps: PreviewBpmDeps, url: string): Promise<TempoEstimate | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!(PREVIEW_HOSTS as readonly string[]).includes(host)) return null;
  const ffmpeg = await deps.ffmpeg();
  if (!ffmpeg.available || !ffmpeg.path) return null;

  const res = await deps.http.request(url, { allowedHosts: PREVIEW_HOSTS, timeoutMs: 15_000, maxBytes: MAX_CLIP_BYTES }).catch(() => null);
  if (!res || res.status !== 200) return null;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_CLIP_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const clip = await readCapped(res.body, MAX_CLIP_BYTES);
  if (!clip || clip.byteLength === 0) return null;

  const pcm = await decode(ffmpeg.path, clip, deps.ffmpegArgsOverride);
  if (!pcm) return null;
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return estimateTempo(samples, SAMPLE_RATE);
}

/** Reads a stream into memory up to a cap; over the cap the clip is abandoned rather than truncated. */
async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function decode(ffmpegPath: string, clip: Uint8Array, argsOverride?: string[]): Promise<Uint8Array | null> {
  const args = argsOverride ?? ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-t', String(CLIP_SECONDS), 'pipe:1'];
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, DECODE_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_PCM_BYTES) {
        child.kill();
        finish(null);
        return;
      }
      chunks.push(c);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(clip);
  });
}
