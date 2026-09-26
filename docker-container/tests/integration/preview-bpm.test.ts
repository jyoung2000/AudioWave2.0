import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, type TestHub } from '../helpers/hub.js';
import { bpmFromPreviewClip, MAX_CLIP_BYTES, PREVIEW_HOSTS } from '../../src/enrichment/preview-bpm.js';

/** A stand-in for ffmpeg: node itself, writing 20 s of 120 bpm clicks as s16le mono 22050 to stdout. */
const CLICK_SCRIPT =
  'const sr=22050,sec=20,bpm=120;const n=sr*sec;const b=Buffer.alloc(n*2);const period=60/bpm*sr;' +
  'for(let t=0;t<n;t+=period){const s=Math.round(t);for(let i=0;i<200&&s+i<n;i++){b.writeInt16LE(Math.round((1-i/200)*(i%2?1:-1)*20000),(s+i)*2);}}' +
  'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(b);});process.stdin.on("data",()=>{});';

const FAKE_FFMPEG = { available: true, path: process.execPath, version: 'fake', encoders: [] };
const NO_FFMPEG = { available: false, path: null, version: null, encoders: [] };

describe('bpm from a preview clip', () => {
  let hub: TestHub;
  beforeEach(async () => { hub = await createTestHub({ ffmpeg: FAKE_FFMPEG }); });
  afterEach(async () => { await hub.close(); });

  it('lists exactly the four preview hosts', () => {
    expect([...PREVIEW_HOSTS]).toEqual(['audio-ssl.itunes.apple.com', 'p.scdn.co', 'cf-media.sndcdn.com', 'cf-hls-media.sndcdn.com']);
    expect(MAX_CLIP_BYTES).toBe(4 * 1024 * 1024);
  });

  it('refuses hosts that are not preview hosts, without a request', async () => {
    expect(await bpmFromPreviewClip(hub.ctx, 'https://www.youtube.com/watch?v=x')).toBeNull();
    expect(await bpmFromPreviewClip(hub.ctx, 'https://p.scdn.co.evil.example/mp3-preview/x')).toBeNull();
    expect(hub.fetch.calls).toHaveLength(0);
  });

  it('gives up on a clip over the size cap without decoding', async () => {
    hub.fetch.on('p.scdn.co/mp3-preview/big', () => ({ status: 200, headers: { 'content-length': String(5 * 1024 * 1024), 'content-type': 'audio/mpeg' }, body: 'x' }));
    expect(await bpmFromPreviewClip(hub.ctx, 'https://p.scdn.co/mp3-preview/big')).toBeNull();
  });

  it('is null when ffmpeg is absent, and fetches nothing', async () => {
    const bare = await createTestHub({ ffmpeg: NO_FFMPEG });
    try {
      bare.fetch.on('p.scdn.co/mp3-preview/x', () => ({ status: 200, body: 'x' }));
      expect(await bpmFromPreviewClip(bare.ctx, 'https://p.scdn.co/mp3-preview/x')).toBeNull();
      expect(bare.fetch.calls).toHaveLength(0);
    } finally {
      await bare.close();
    }
  });

  it('decodes through the given ffmpeg and hears the tempo', async () => {
    hub.fetch.on('audio-ssl.itunes.apple.com/clip', () => ({ status: 200, headers: { 'content-type': 'audio/mp4' }, body: 'not-really-audio' }));
    const r = await bpmFromPreviewClip({ ...hub.ctx, ffmpegArgsOverride: ['-e', CLICK_SCRIPT] }, 'https://audio-ssl.itunes.apple.com/clip');
    expect(r?.bpm).toBe(120);
    expect(r!.confidence).toBeGreaterThan(1.5);
  });
});
