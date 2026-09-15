/**
 * WAV, because it is the format every machine on earth can open.
 *
 * A RIFF header and the samples: no compression, no cleverness, nothing that
 * can go subtly wrong. It is large — about 10 MB a minute at 24-bit stereo —
 * which is why FLAC exists beside it, but it is the one export that is
 * certain to play wherever it lands.
 */
import { frameCount, toInt, type BitDepth, type PcmSource } from './pcm.js';

export function encodeWav(source: PcmSource, depth: BitDepth = 24): Uint8Array {
  const channels = source.channels.length;
  const frames = frameCount(source);
  const bytesPerSample = depth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format: integer PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, source.sampleRate, true);
  view.setUint32(28, source.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, depth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let at = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const value = toInt(source.channels[c]![i]!, depth);
      if (depth === 16) {
        view.setInt16(at, value, true);
        at += 2;
      } else {
        // 24-bit has no DataView helper: three bytes, little end first.
        out[at] = value & 0xff;
        out[at + 1] = (value >> 8) & 0xff;
        out[at + 2] = (value >> 16) & 0xff;
        at += 3;
      }
    }
  }
  return out;
}
