import { estimateTempo, type TempoEstimate } from '@now-playing/audio-core/tempo';
import { spawn } from 'node:child_process';

/**
 * A tempo measured from the file itself, for music that carries no BPM tag and got no answer from
 * the hub: ffmpeg decodes one minute from the middle — where the song is being itself, not fading
 * in — and the shared estimator listens. Local files, local ffmpeg, no network anywhere. A file
 * that cannot be decoded is a missing answer, never an error.
 */
const SAMPLE_RATE = 22050;
const WINDOW_SECONDS = 60;
const DECODE_TIMEOUT_MS = 30_000;
/** More PCM than the window could hold means the decoder is not doing what it was told. */
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * (WINDOW_SECONDS + 10);

/** The decode arguments, exported so a test can hold them still: a file in, mono PCM out, nothing else. */
export function ANALYSIS_ARGS(startSeconds: number, absolutePath: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-ss', String(startSeconds), '-i', absolutePath, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-t', String(WINDOW_SECONDS), 'pipe:1'];
}

export interface TempoAnalysisDeps {
  ffmpegPath: string;
  signal?: AbortSignal;
  /** Test seam: spawn the binary with these arguments instead of the decode arguments. */
  ffmpegArgsOverride?: string[];
  /** Test seam: how long a silent decoder may hold on. */
  decodeTimeoutMs?: number;
}

export async function analyzeFileTempo(deps: TempoAnalysisDeps, file: { absolutePath: string; durationMs: number | null }): Promise<TempoEstimate | null> {
  if (deps.signal?.aborted) return null;
  const startSeconds = file.durationMs && file.durationMs > 0 ? Math.max(0, Math.round(file.durationMs / 2000) - WINDOW_SECONDS / 2) : 0;
  const args = deps.ffmpegArgsOverride ?? ANALYSIS_ARGS(startSeconds, file.absolutePath);
  const pcm = await decode(deps, args);
  if (!pcm || pcm.byteLength === 0) return null;
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return estimateTempo(samples, SAMPLE_RATE);
}

function decode(deps: TempoAnalysisDeps, args: string[]): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const child = spawn(deps.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      child.kill();
      finish(null);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, deps.decodeTimeoutMs ?? DECODE_TIMEOUT_MS);
    deps.signal?.addEventListener('abort', onAbort, { once: true });
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
  });
}
