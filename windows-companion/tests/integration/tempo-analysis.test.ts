import { describe, expect, it } from 'vitest';
import { analyzeFileTempo, ANALYSIS_ARGS } from '../../src/main/tempo-analysis.js';

/**
 * The measurement itself: ffmpeg decodes a minute from the middle of a file, the shared estimator
 * listens. The "ffmpeg" here is node running a click-track script — the same seam the hub's
 * preview analysis uses — so the tests are deterministic on any machine.
 */

/** Writes 20 s of 120 bpm clicks as s16le mono 22050 to stdout, whatever the input args say. */
const CLICK_SCRIPT =
  'const sr=22050,sec=20,bpm=120;const n=sr*sec;const b=Buffer.alloc(n*2);const period=60/bpm*sr;' +
  'for(let t=0;t<n;t+=period){const s=Math.round(t);for(let i=0;i<200&&s+i<n;i++){b.writeInt16LE(Math.round((1-i/200)*(i%2?1:-1)*20000),(s+i)*2);}}' +
  'process.stdout.write(b);';

const FILE = { absolutePath: 'C:/nowhere/song.flac', durationMs: 200_000 };

describe('analyzeFileTempo', () => {
  it('hears the tempo of what ffmpeg hands it', async () => {
    const r = await analyzeFileTempo({ ffmpegPath: process.execPath, ffmpegArgsOverride: ['-e', CLICK_SCRIPT] }, FILE);
    expect(r?.bpm).toBe(120);
    expect(r!.confidence).toBeGreaterThan(1.5);
  });

  it('a decoder that fails is a missing answer, not a crash', async () => {
    const r = await analyzeFileTempo({ ffmpegPath: process.execPath, ffmpegArgsOverride: ['-e', 'process.exit(1)'] }, FILE);
    expect(r).toBeNull();
  });

  it('a decoder that never finishes is abandoned at the timeout', async () => {
    const t0 = Date.now();
    const r = await analyzeFileTempo({ ffmpegPath: process.execPath, ffmpegArgsOverride: ['-e', 'setInterval(() => {}, 1000);'], decodeTimeoutMs: 400 }, FILE);
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('an abort mid-decode answers null promptly', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const t0 = Date.now();
    const r = await analyzeFileTempo({ ffmpegPath: process.execPath, ffmpegArgsOverride: ['-e', 'setTimeout(() => {}, 8000);'], signal: ctl.signal }, FILE);
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it('the decode arguments read a minute from the middle, mono, and never a network protocol', () => {
    const args = ANALYSIS_ARGS(70, 'C:/music/song.flac');
    const iAt = args.indexOf('-i');
    expect(args[iAt + 1]).toBe('C:/music/song.flac');
    expect(args.indexOf('-ss')).toBeLessThan(iAt);
    expect(args[args.indexOf('-ss') + 1]).toBe('70');
    expect(args[args.indexOf('-t') + 1]).toBe('60');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args[args.indexOf('-ar') + 1]).toBe('22050');
    expect(args[args.indexOf('-f') + 1]).toBe('s16le');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  it('the middle of a short file is its start', async () => {
    // durationMs null → start at 0; the seam only proves the call is made, the args test above pins the maths
    const r = await analyzeFileTempo({ ffmpegPath: process.execPath, ffmpegArgsOverride: ['-e', CLICK_SCRIPT] }, { absolutePath: 'x.wav', durationMs: null });
    expect(r?.bpm).toBe(120);
  });
});
