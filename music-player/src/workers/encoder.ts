/**
 * Encoding, off the interface's thread.
 *
 * Decoding stays on the main thread because only it has an AudioContext, and
 * the browser's decoder is native and quick. Encoding is ours and is not: a
 * five-minute track is thirteen million samples, and doing that between
 * animation frames would lock the page for seconds. So the decoded channels
 * are handed over here — transferred, not copied — and the bytes come back.
 */
import { encodeFlac, encodeWav, type BitDepth } from '@now-playing/audio-core';

interface EncodeRequest {
  format: 'flac' | 'wav';
  channels: Float32Array[];
  sampleRate: number;
  depth: BitDepth;
}

const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null };

scope.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { format, channels, sampleRate, depth } = event.data;
  try {
    const source = { channels, sampleRate };
    const bytes = format === 'flac' ? encodeFlac(source, { depth }) : encodeWav(source, depth);
    scope.postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (error) {
    scope.postMessage({ ok: false, reason: error instanceof Error ? error.message : String(error) });
  }
};
