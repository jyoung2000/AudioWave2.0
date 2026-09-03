/** Deterministic PCM WAV synthesis for redistributable test audio. */

export interface ToneSpec {
  seconds: number;
  sampleRate?: number;
  channels?: 1 | 2;
  /** Sequence of [frequencyHz, seconds] segments; a simple melody keeps fixtures recognisable. */
  notes: Array<[number, number]>;
  gain?: number;
}

export function synthesizePcm16(spec: ToneSpec): { samples: Int16Array; sampleRate: number; channels: number } {
  const sampleRate = spec.sampleRate ?? 44100;
  const channels = spec.channels ?? 2;
  const total = Math.floor(spec.seconds * sampleRate);
  const samples = new Int16Array(total * channels);
  const gain = spec.gain ?? 0.35;
  let cursor = 0;
  let noteIndex = 0;
  let noteRemaining = Math.floor((spec.notes[0]?.[1] ?? spec.seconds) * sampleRate);
  let phase = 0;
  for (let i = 0; i < total; i += 1) {
    if (noteRemaining <= 0 && noteIndex < spec.notes.length - 1) {
      noteIndex += 1;
      noteRemaining = Math.floor(spec.notes[noteIndex]![1] * sampleRate);
    }
    const freq = spec.notes[noteIndex]?.[0] ?? 440;
    phase += (2 * Math.PI * freq) / sampleRate;
    // soft envelope at note edges to avoid clicks
    const env = Math.min(1, noteRemaining / (sampleRate * 0.01), (Math.floor(spec.notes[noteIndex]![1] * sampleRate) - noteRemaining) / (sampleRate * 0.01) + 0.05);
    const v = Math.sin(phase) * 0.8 + Math.sin(phase * 2) * 0.15 + Math.sin(phase * 3) * 0.05;
    const s = Math.round(Math.max(-1, Math.min(1, v * gain * env)) * 32767);
    for (let c = 0; c < channels; c += 1) samples[cursor++] = s;
    noteRemaining -= 1;
  }
  return { samples, sampleRate, channels };
}

export interface WavTags {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: string;
  track?: string;
  comment?: string;
}

/** Encode PCM16 as RIFF/WAVE with an INFO LIST chunk carrying metadata (readable by music-metadata). */
export function encodeWav(pcm: { samples: Int16Array; sampleRate: number; channels: number }, tags: WavTags = {}): Uint8Array {
  const dataBytes = pcm.samples.length * 2;
  const infoEntries: Array<[string, string]> = [];
  const map: Record<keyof WavTags, string> = { title: 'INAM', artist: 'IART', album: 'IPRD', genre: 'IGNR', year: 'ICRD', track: 'ITRK', comment: 'ICMT' };
  for (const [key, id] of Object.entries(map) as Array<[keyof WavTags, string]>) {
    const v = tags[key];
    if (v) infoEntries.push([id, v]);
  }
  let listSize = 4;
  const encoded = infoEntries.map(([id, v]) => {
    const bytes = new TextEncoder().encode(v + '\0');
    const padded = bytes.length % 2 ? bytes.length + 1 : bytes.length;
    listSize += 8 + padded;
    return { id, bytes, padded };
  });
  const listChunk = encoded.length ? 8 + listSize : 0;
  const totalSize = 4 + (8 + 16) + (8 + dataBytes) + listChunk;
  const buf = new ArrayBuffer(8 + totalSize);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let o = 0;
  const str = (s: string) => {
    for (let i = 0; i < s.length; i += 1) out[o++] = s.charCodeAt(i);
  };
  const u32 = (n: number) => {
    view.setUint32(o, n, true);
    o += 4;
  };
  const u16 = (n: number) => {
    view.setUint16(o, n, true);
    o += 2;
  };
  str('RIFF');
  u32(totalSize);
  str('WAVE');
  str('fmt ');
  u32(16);
  u16(1);
  u16(pcm.channels);
  u32(pcm.sampleRate);
  u32(pcm.sampleRate * pcm.channels * 2);
  u16(pcm.channels * 2);
  u16(16);
  if (encoded.length) {
    str('LIST');
    u32(listSize);
    str('INFO');
    for (const e of encoded) {
      str(e.id);
      u32(e.bytes.length);
      out.set(e.bytes, o);
      o += e.padded;
    }
  }
  str('data');
  u32(dataBytes);
  for (let i = 0; i < pcm.samples.length; i += 1) {
    view.setInt16(o, pcm.samples[i]!, true);
    o += 2;
  }
  return out;
}

export function makeToneWav(spec: ToneSpec, tags: WavTags): Uint8Array {
  return encodeWav(synthesizePcm16(spec), tags);
}
