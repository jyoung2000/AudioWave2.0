/**
 * A visitor's fetch (NP-FIND-011/012): the pure parts. What a file the hub sends as
 * application/octet-stream is, from its first bytes (the library indexes by extension), and how a
 * row that came from a bare link becomes the catalog song the hub's catalog/download reads.
 */
import { describe, expect, it } from 'vitest';
import { sniffExtension, trackOf } from '../../src/shell/search/visit.js';

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) out.push(...(typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p));
  while (out.length < 40) out.push(0);
  return new Uint8Array(out);
};

describe('a fetched file', () => {
  it('reads what a fetched file is from its first bytes', () => {
    expect(sniffExtension(bytes('ID3', [4, 0]))).toBe('.mp3');
    expect(sniffExtension(bytes([0xff, 0xfb, 0x90]))).toBe('.mp3');
    expect(sniffExtension(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toBe('.m4a');
    expect(sniffExtension(bytes('fLaC'))).toBe('.flac');
    expect(sniffExtension(bytes('OggS', new Array(24).fill(0), 'OpusHead'))).toBe('.opus');
    expect(sniffExtension(bytes('OggS', new Array(24).fill(0), '\u0001vorbis'))).toBe('.ogg');
    expect(sniffExtension(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('.wav');
    expect(sniffExtension(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBe('.webm');
    expect(sniffExtension(bytes([0xff, 0xf1]))).toBe('.aac');
    expect(sniffExtension(bytes('<!doctype html>'))).toBeNull();
  });
});

describe('a link row for the hub', () => {
  it('names a link row’s platform for the hub, and refuses a link it does not know', () => {
    const t = trackOf({ id: 'song-add-1', title: 'Far Signal', artist: 'Cedar Trio', duration: 214, url: 'https://soundcloud.com/cedar/far-signal' });
    expect(t).not.toBeNull();
    expect(t!.sources).toEqual([{ platform: 'soundcloud', id: null, url: 'https://soundcloud.com/cedar/far-signal', previewUrl: null, matchedBy: 'link' }]);
    expect(t!.durationMs).toBe(214_000);
    expect(t!.artists).toEqual(['Cedar Trio']);
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://music.youtube.com/watch?v=abc' })!.sources[0]!.platform).toBe('youtube-music');
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://youtu.be/abc' })!.sources[0]!.platform).toBe('youtube');
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'https://example.com/song.mp3' })).toBeNull();
    expect(trackOf({ id: 'x', title: 'A', artist: '', url: 'javascript:alert(1)' })).toBeNull();
  });
});
