import { describe, expect, it } from 'vitest';
import { encodeWav, makeToneWav, synthesizePcm16 } from './wav.js';
import { generateListeningEvents } from './events.js';
import { fixtureSearchResults, CAPS_FULL } from './providers.js';

describe('fixtures', () => {
  it('synthesizes deterministic wav bytes with INFO tags', () => {
    const a = makeToneWav({ seconds: 1, notes: [[440, 1]] }, { title: 'T', artist: 'A' });
    const b = makeToneWav({ seconds: 1, notes: [[440, 1]] }, { title: 'T', artist: 'A' });
    expect(a).toEqual(b);
    expect(new TextDecoder().decode(a.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(a).includes('INAM')).toBe(true);
    const pcm = synthesizePcm16({ seconds: 0.5, notes: [[440, 0.5]], channels: 1 });
    expect(pcm.samples.length).toBe(22050);
    expect(encodeWav(pcm).length).toBe(44 + 22050 * 2);
  });
  it('generates deterministic listening events', () => {
    const a = generateListeningEvents({ deviceId: '0192b1f0-0000-7000-8000-00000000d001', days: 5, seed: 3 });
    const b = generateListeningEvents({ deviceId: '0192b1f0-0000-7000-8000-00000000d001', days: 5, seed: 3 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
    expect(a.every((e) => e.occurredAt.endsWith('Z'))).toBe(true);
  });
  it('fixture search filters by query', () => {
    expect(fixtureSearchResults('fx', 'copper', CAPS_FULL)).toHaveLength(2);
    expect(fixtureSearchResults('fx', 'zzz', CAPS_FULL)).toHaveLength(0);
  });
});
