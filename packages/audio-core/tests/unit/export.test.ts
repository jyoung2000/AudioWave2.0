import { describe, expect, it } from 'vitest';
import { BitWriter, crc16, crc8, encodeFlac, encodeWav, toInt, writeUtf8Number } from '../../src/index.js';

describe('the bit writer', () => {
  it('writes most significant bit first, across byte boundaries', () => {
    const w = new BitWriter();
    w.write(0b101, 3);
    w.write(0b11110000, 8);
    w.write(0b1, 1);
    // 101 11110000 1 then four zero bits of padding.
    expect([...w.toBytes()]).toEqual([0b10111110, 0b00010000]);
  });

  it("writes two's complement for negative values", () => {
    const w = new BitWriter();
    w.writeSigned(-1, 8);
    w.writeSigned(-128, 8);
    w.writeSigned(127, 8);
    expect([...w.toBytes()]).toEqual([0xff, 0x80, 0x7f]);
  });

  it('spells a Rice quotient as that many zeros and a one', () => {
    const w = new BitWriter();
    w.writeUnary(0);
    w.writeUnary(3);
    expect([...w.toBytes()]).toEqual([0b10001000]);
  });

  it('handles counts wider than a 32-bit shift', () => {
    const w = new BitWriter();
    w.write(2 ** 35 + 1, 36);
    const bytes = w.toBytes();
    expect(bytes.length).toBe(5); // 36 bits padded to 40
    expect(bytes[0]! >> 3).toBe(0b10000);
  });
});

describe('the FLAC check values', () => {
  it('computes the CRC-8 the frame header carries', () => {
    expect(crc8(new Uint8Array([]))).toBe(0);
    expect(crc8(new Uint8Array([0x00]))).toBe(0);
    // Worked through the polynomial x^8+x^2+x+1 by hand for a single byte.
    expect(crc8(new Uint8Array([0x01]))).toBe(0x07);
    expect(crc8(new Uint8Array([0xff, 0xf8]))).toBe(crc8(new Uint8Array([0xff, 0xf8])));
  });

  it('computes the CRC-16 the frame ends with', () => {
    expect(crc16(new Uint8Array([]))).toBe(0);
    expect(crc16(new Uint8Array([0x00, 0x00]))).toBe(0);
    expect(crc16(new Uint8Array([0x01]))).toBe(0x8005);
  });

  it("encodes a frame number in FLAC's UTF-8-shaped integer", () => {
    const at = (value: number): number[] => {
      const w = new BitWriter();
      writeUtf8Number(w, value);
      return [...w.toBytes()];
    };
    expect(at(0)).toEqual([0x00]);
    expect(at(0x7f)).toEqual([0x7f]);
    expect(at(0x80)).toEqual([0xc2, 0x80]);
    expect(at(0x7ff)).toEqual([0xdf, 0xbf]);
    expect(at(0x800)).toEqual([0xe0, 0xa0, 0x80]);
  });
});

/** A short signal with silence, a tone and noise, so every subframe type is reached. */
function testSignal(frames: number, rate = 44100): { channels: Float32Array[]; sampleRate: number } {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    if (i < 500) continue; // silence
    else if (i < frames / 2) {
      left[i] = 0.4 * Math.sin(2 * Math.PI * 220 * t);
      right[i] = 0.4 * Math.sin(2 * Math.PI * 221 * t);
    } else {
      left[i] = 0.3 * rnd();
      right[i] = 0.3 * rnd();
    }
  }
  return { channels: [left, right], sampleRate: rate };
}

describe('WAV', () => {
  it('writes a RIFF header that describes the samples that follow', () => {
    const wav = encodeWav(testSignal(1000), 24);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const text = (at: number, n: number): string => String.fromCharCode(...wav.subarray(at, at + n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true), 'integer PCM').toBe(1);
    expect(view.getUint16(22, true), 'stereo').toBe(2);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(24);
    expect(text(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(1000 * 2 * 3);
    expect(wav.length).toBe(44 + 1000 * 2 * 3);
    expect(view.getUint32(4, true), 'RIFF size counts everything after it').toBe(wav.length - 8);
  });

  it('clamps rather than wrapping at full scale', () => {
    expect(toInt(1, 16)).toBe(32767);
    expect(toInt(-1, 16)).toBe(-32768);
    expect(toInt(2, 16), 'a sample over full scale is held, not wrapped').toBe(32767);
    expect(toInt(-2, 16)).toBe(-32768);
    expect(toInt(0, 24)).toBe(0);
  });
});

describe('FLAC', () => {
  it('writes a stream that opens with fLaC and a STREAMINFO describing it', () => {
    const frames = 9000; // more than two blocks, and not a multiple of one
    const flac = encodeFlac(testSignal(frames), { depth: 24 });
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe('fLaC');

    // Metadata block header: last-block flag set, type 0, length 34.
    expect(flac[4]! & 0x80, 'STREAMINFO is the last metadata block').toBe(0x80);
    expect(flac[4]! & 0x7f, 'block type 0').toBe(0);
    expect((flac[5]! << 16) | (flac[6]! << 8) | flac[7]!).toBe(34);

    const info = flac.subarray(8, 8 + 34);
    const minBlock = (info[0]! << 8) | info[1]!;
    const maxBlock = (info[2]! << 8) | info[3]!;
    expect(maxBlock).toBe(4096);
    expect(minBlock, 'the short last block is the smallest').toBe(frames % 4096);

    // 20 bits of sample rate, 3 of channels-1, 5 of depth-1, then 36 of length.
    const rate = (info[10]! << 12) | (info[11]! << 4) | (info[12]! >> 4);
    expect(rate).toBe(44100);
    expect(((info[12]! >> 1) & 0b111) + 1, 'stereo').toBe(2);
    const depth = (((info[12]! & 1) << 4) | (info[13]! >> 4)) + 1;
    expect(depth).toBe(24);
    const total = ((info[13]! & 0x0f) * 2 ** 32) + (info[14]! << 24 >>> 0) + (info[15]! << 16) + (info[16]! << 8) + info[17]!;
    expect(total).toBe(frames);

    // The next thing after STREAMINFO must be a frame, which starts with the sync code.
    expect(flac[42]).toBe(0xff);
    expect(flac[43]! & 0xfc).toBe(0xf8);
  });

  it('compresses, which is the entire point of choosing it over WAV', () => {
    const signal = testSignal(40000);
    const flac = encodeFlac(signal, { depth: 24 });
    const wav = encodeWav(signal, 24);
    expect(flac.length).toBeLessThan(wav.length * 0.8);
  });

  it('collapses digital silence to almost nothing', () => {
    const frames = 40000;
    const silent = { channels: [new Float32Array(frames), new Float32Array(frames)], sampleRate: 44100 };
    const flac = encodeFlac(silent, { depth: 24 });
    // A constant subframe is one sample per channel per block, so a minute of
    // silence is bytes rather than megabytes.
    expect(flac.length).toBeLessThan(400);
  });

  it('refuses a sample rate a frame header cannot name, rather than mislabelling it', () => {
    expect(() => encodeFlac({ channels: [new Float32Array(10)], sampleRate: 44101 }, {})).toThrow(/sample rate/i);
  });

  it('carries mono as readily as stereo', () => {
    const frames = 5000;
    const mono = { channels: [testSignal(frames).channels[0]!], sampleRate: 48000 };
    const flac = encodeFlac(mono, { depth: 16 });
    const info = flac.subarray(8, 8 + 34);
    expect(((info[12]! >> 1) & 0b111) + 1).toBe(1);
    expect((((info[12]! & 1) << 4) | (info[13]! >> 4)) + 1).toBe(16);
  });
});
