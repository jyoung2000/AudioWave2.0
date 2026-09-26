import type { FfmpegInfo } from '../deps.js';
import type { Logger } from 'pino';
import type { SafeHttpClient } from '../providers/http.js';

export interface PreviewBpmDeps {
  http: SafeHttpClient;
  ffmpeg: () => Promise<FfmpegInfo>;
  log: Logger;
}

/** Stub until the clip analysis lands (plan task 10): no clip is ever fetched from here yet. */
export async function bpmFromPreviewClip(_deps: PreviewBpmDeps, _url: string): Promise<{ bpm: number; confidence: number } | null> {
  return null;
}
