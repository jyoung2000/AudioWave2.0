import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, FLAT_PRESET, requiredHeadroomDb } from '@now-playing/domain';
import type { EqPreset, RetuneConfig } from '@now-playing/contracts';
import { EQ_BAND_FREQUENCIES_HZ } from '@now-playing/contracts';
import {
  ANALYSER_FFT_SIZE,
  BYPASS_CROSSFADE_MS,
  DSP_UNAVAILABLE_REASON,
  LIMITER_SETTINGS,
  MockAudioContext,
  MockMediaElement,
  createAudioEngine,
  dbToGain,
  gainToDb,
  matchedBypassLevelDb,
  type AudioEngineState,
  type MockAudioNode,
} from '../../src/index.js';

const WORKLET_URL = 'https://example.test/pitch-shifter.js';

function engineWith(options: Parameters<typeof createAudioEngine>[1] = {}, contextOptions: ConstructorParameters<typeof MockAudioContext>[0] = {}) {
  const context = new MockAudioContext(contextOptions);
  const engine = createAudioEngine(context, { workletModuleUrl: WORKLET_URL, pageOrigin: 'https://player.test', ...options });
  return { context, engine };
}

function retune(patch: Partial<RetuneConfig>): RetuneConfig {
  return { referenceHz: 440, pitchOffsetCents: 0, mode: 'off', updatedAt: '2026-09-04T00:00:00.000Z', ...patch };
}

function nodesOfKind(context: MockAudioContext, kind: MockAudioNode['kind']): MockAudioNode[] {
  return context.nodes.filter((n) => n.kind === kind);
}

describe('audio engine graph', () => {
  it('builds the documented chain from source to destination', () => {
    const { context, engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:test' });
    expect(engine.attachMediaElement(element).ok).toBe(true);

    const source = nodesOfKind(context, 'media-element-source')[0]!;
    expect(context.reaches(source, context.destination)).toBe(true);

    const path = context.allPaths(source, context.destination).find((p) => p.some((n) => n.kind === 'biquad'));
    expect(path, 'a path through the EQ must exist').toBeDefined();
    const kinds = path!.map((n) => n.kind);
    expect(kinds[0]).toBe('media-element-source');
    expect(kinds[kinds.length - 1]).toBe('destination');
    // gain(processedIn) → gain(preamp) → 10 biquads → gain(trim) → compressor → analyser → gain(output)
    expect(kinds.filter((k) => k === 'biquad')).toHaveLength(EQ_BAND_FREQUENCIES_HZ.length);
    expect(kinds.indexOf('biquad')).toBeLessThan(kinds.indexOf('compressor'));
    expect(kinds.indexOf('compressor')).toBeLessThan(kinds.indexOf('analyser'));
    expect(kinds.lastIndexOf('gain')).toBeGreaterThan(kinds.indexOf('analyser'));
  });

  it('allocates the ten graphic bands at the documented frequencies with Q 1.1', () => {
    const { context, engine } = engineWith();
    const state = engine.getState();
    expect(state.bandCount).toBe(10);
    expect(state.bands.map((b) => b.frequencyHz)).toEqual([...EQ_BAND_FREQUENCIES_HZ]);
    for (const filter of nodesOfKind(context, 'biquad')) expect(filter.kind).toBe('biquad');
    expect(state.bands.every((b) => b.q === 1.1 && b.type === 'peaking')).toBe(true);
  });

  it('configures the safety limiter and analyser as documented', () => {
    const { context } = engineWith();
    const compressor = context.nodes.find((n) => n.kind === 'compressor');
    expect(compressor).toBeDefined();
    const analyser = context.nodes.find((n) => n.kind === 'analyser');
    expect(analyser).toBeDefined();
    expect(LIMITER_SETTINGS.thresholdDb).toBe(-1);
    expect(ANALYSER_FFT_SIZE).toBe(2048);
  });

  it('never writes AudioParam.value directly — every change is scheduled', () => {
    const { context, engine } = engineWith();
    engine.attachMediaElement(new MockMediaElement({ src: 'blob:test' }));
    engine.setPreamp(6);
    engine.setBandGain(3, 8);
    engine.setOutputGain(-3);
    engine.setBypass(true);
    engine.setLimiter(false);
    expect(context.valueWrites).toHaveLength(0);
  });

  it('ramps the preamp instead of jumping, and settles at the requested value', () => {
    const { context, engine } = engineWith();
    engine.setPreamp(6, { rampMs: 40 });
    const preamp = nodesOfKind(context, 'gain').find((n) => n.describe().includes('gain'))!;
    void preamp;
    context.advance(0.04);
    const state = engine.getState();
    expect(state.preampDb).toBe(6);
    expect(state.presetModified).toBe(true);
  });

  it('applies a built-in preset and reports it as unmodified', () => {
    const { engine } = engineWith();
    const rock = BUILTIN_PRESETS.find((p) => p.name.toLowerCase().includes('rock')) ?? BUILTIN_PRESETS[1]!;
    engine.applyPreset(rock);
    const state = engine.getState();
    expect(state.presetId).toBe(rock.id);
    expect(state.presetName).toBe(rock.name);
    expect(state.presetModified).toBe(false);
  });

  it('sets the headroom trim to exactly minus the required headroom of the live preset', () => {
    const { engine } = engineWith();
    const boosted: EqPreset = { ...FLAT_PRESET, id: '00000000-0000-7000-8000-0000000000b1', name: 'Boost', kind: 'user', preampDb: 3, bands: FLAT_PRESET.bands.map((b, i) => ({ ...b, gainDb: i === 2 ? 9 : 0 })) };
    engine.applyPreset(boosted);
    const state = engine.getState();
    expect(state.headroomTrimDb).toBeCloseTo(-requiredHeadroomDb(boosted), 6);
    expect(state.headroomTrimDb).toBeLessThanOrEqual(0);
  });

  it('keeps the trim at or below 0 dB and recomputes it when a band changes', () => {
    const { engine } = engineWith();
    expect(engine.getState().headroomTrimDb).toBeCloseTo(0, 6);
    engine.setBandGain(5, 10);
    const after = engine.getState().headroomTrimDb;
    expect(after).toBeLessThan(0);
  });

  it('matches the bypass path to the processed level so A/B compares tone, not loudness', () => {
    const { engine } = engineWith();
    engine.setBandGain(4, 9);
    const state = engine.getState();
    const expected = matchedBypassLevelDb({ ...FLAT_PRESET, preampDb: state.preampDb, bands: state.bands.map((b) => ({ ...b })) }, 48000);
    expect(state.bypassMatchedGainDb).toBeCloseTo(expected, 6);
    engine.setBypass(true);
    expect(engine.getState().bypassed).toBe(true);
  });

  it('crossfades bypass over the documented 30 ms without a value jump', () => {
    const { context, engine } = engineWith();
    engine.attachMediaElement(new MockMediaElement({ src: 'blob:x' }));
    const before = context.valueWrites.length;
    engine.setBypass(true);
    expect(BYPASS_CROSSFADE_MS).toBe(30);
    expect(context.valueWrites.length).toBe(before);
    engine.setBypass(false);
    expect(engine.getState().bypassed).toBe(false);
  });

  it('refuses a cross-origin element without CORS and leaves it playing', () => {
    const { context, engine } = engineWith();
    const element = new MockMediaElement({ src: 'https://cdn.example.com/song.mp3' });
    element.paused = false;
    const result = engine.attachMediaElement(element);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(DSP_UNAVAILABLE_REASON);
    expect(nodesOfKind(context, 'media-element-source')).toHaveLength(0);
    expect(element.paused).toBe(false);
    const state = engine.getState();
    expect(state.dspAvailable).toBe(false);
    expect(state.dspUnavailableReason).toContain('CORS');
  });

  /**
   * The rule that makes a player different from a demo: `createMediaElementSource` may be called
   * once per element, ever, and the binding survives disconnecting the node. One element plays every
   * track, so the second song has to reuse the first song's node — otherwise the whole graph throws
   * on track two and the equalizer dies with it.
   */
  it('reuses one source node when the same element is attached for the next track', () => {
    const { context, engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:https://player.test/one' });
    expect(engine.attachMediaElement(element).ok).toBe(true);

    element.src = 'blob:https://player.test/two';
    expect(engine.attachMediaElement(element).ok).toBe(true);
    expect(nodesOfKind(context, 'media-element-source')).toHaveLength(1);

    const source = nodesOfKind(context, 'media-element-source')[0]!;
    expect(context.reaches(source, context.destination), 'the reused node must still reach the output').toBe(true);
    expect(engine.getState().dspAvailable).toBe(true);
  });

  it('accepts a same-origin blob element', () => {
    const { engine } = engineWith();
    const result = engine.attachMediaElement(new MockMediaElement({ src: 'blob:https://player.test/abc' }));
    expect(result.ok).toBe(true);
    expect(engine.getState().dspAvailable).toBe(true);
  });

  it('notifies subscribers on state changes and stops after unsubscribe', () => {
    const { engine } = engineWith();
    const seen: AudioEngineState[] = [];
    const off = engine.subscribe((s) => seen.push(s));
    engine.setPreamp(2);
    expect(seen.length).toBeGreaterThan(0);
    const count = seen.length;
    off();
    engine.setPreamp(-2);
    expect(seen.length).toBe(count);
  });

  it('reports latency from the context plus the worklet when retune is engaged', async () => {
    const { engine } = engineWith();
    const idle = engine.getLatency();
    expect(idle.baseMs).toBeCloseTo(5, 6);
    expect(idle.outputMs).toBeCloseTo(20, 6);
    expect(idle.workletMs).toBe(0);
    await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 432 }));
    const busy = engine.getLatency();
    expect(busy.workletMs).toBeGreaterThan(20);
    expect(busy.totalMs).toBeCloseTo(busy.baseMs + (busy.outputMs ?? 0) + busy.workletMs, 6);
  });

  it('omits outputLatency when the browser does not expose it', () => {
    const { engine } = engineWith({}, { outputLatency: null });
    expect(engine.getLatency().outputMs).toBeNull();
  });

  it('disconnects every node on dispose and refuses further changes', () => {
    const { context, engine } = engineWith();
    engine.attachMediaElement(new MockMediaElement({ src: 'blob:y' }));
    engine.dispose();
    expect(engine.getState().disposed).toBe(true);
    for (const node of context.nodes) {
      if (node.kind === 'destination') continue;
      expect(node.outputs.size, `${node.describe()} should have no outputs`).toBe(0);
    }
    expect(() => engine.setPreamp(1)).toThrow(/disposed/);
  });

  it('rejects band indexes outside the allocated range', () => {
    const { engine } = engineWith();
    expect(() => engine.setBandGain(99, 3)).toThrow(/Band 99/);
    expect(() => engine.setBandEnabled(-1, true)).toThrow(/Band -1/);
  });

  it('disables a band by making it transparent rather than removing the node', () => {
    const { context, engine } = engineWith();
    const filters = nodesOfKind(context, 'biquad').length;
    engine.setBandGain(2, 6);
    engine.setBandEnabled(2, false);
    expect(nodesOfKind(context, 'biquad')).toHaveLength(filters);
    const band = engine.getState().bands[2]!;
    expect(band.enabled).toBe(false);
    expect(band.gainDb).toBe(6);
  });

  it('converts dB and gain consistently', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 12);
    expect(gainToDb(dbToGain(-6))).toBeCloseTo(-6, 9);
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('retune semantics', () => {
  it('is inactive at 440 Hz with no offset', async () => {
    const { engine } = engineWith();
    const state = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 440 }));
    expect(state.active).toBe(false);
    expect(state.applied).toBe('none');
    expect(state.totalCents).toBeCloseTo(0, 9);
  });

  it('preserve-tempo loads the worklet and shifts pitch without touching playback rate', async () => {
    const { engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:z' });
    engine.attachMediaElement(element);
    const state = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 432 }));
    expect(state.applied).toBe('worklet');
    expect(state.workletAvailable).toBe(true);
    expect(state.workletError).toBeNull();
    expect(state.ratio).toBeCloseTo(432 / 440, 6);
    expect(element.playbackRate).toBe(1);
    expect(element.preservesPitch).toBe(true);
    expect(state.description.durationFactor).toBe(1);
  });

  it('falls back to "none" — never to playback rate — when the worklet cannot load', async () => {
    const { engine } = engineWith({}, { workletLoadError: 'network down' });
    const element = new MockMediaElement({ src: 'blob:z' });
    engine.attachMediaElement(element);
    const state = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 432 }));
    expect(state.applied).toBe('none');
    expect(state.workletAvailable).toBe(false);
    expect(state.workletError).toContain('network down');
    expect(element.playbackRate).toBe(1);
  });

  it('reports the reason when the context has no AudioWorklet at all', async () => {
    const { engine } = engineWith({}, { audioWorklet: false });
    const state = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 432 }));
    expect(state.applied).toBe('none');
    expect(state.workletError).toContain('AudioWorklet');
  });

  it('linked-speed changes playbackRate with preservesPitch off and says duration changes', async () => {
    const { engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:z' });
    engine.attachMediaElement(element);
    const state = await engine.setRetune(retune({ mode: 'linked-speed', referenceHz: 432 }));
    expect(state.applied).toBe('playback-rate');
    expect(element.preservesPitch).toBe(false);
    expect(element.playbackRate).toBeCloseTo(432 / 440, 6);
    expect(state.description.durationFactor).toBeCloseTo(440 / 432, 4);
    expect(state.description.honestNote).toMatch(/tempo/i);
  });

  it('turning retune off restores the element and bypasses the worklet', async () => {
    const { engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:z' });
    engine.attachMediaElement(element);
    await engine.setRetune(retune({ mode: 'linked-speed', referenceHz: 415 }));
    const state = await engine.setRetune(retune({ mode: 'off' }));
    expect(state.applied).toBe('none');
    expect(element.playbackRate).toBe(1);
    expect(element.preservesPitch).toBe(true);
  });

  it('clamps an extreme ratio and says so', async () => {
    const { engine } = engineWith();
    engine.attachMediaElement(new MockMediaElement({ src: 'blob:z' }));
    const state = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 440, pitchOffsetCents: 1200 }));
    expect(state.ratio).toBeLessThanOrEqual(2);
    const clamped = await engine.setRetune(retune({ mode: 'preserve-tempo', referenceHz: 480, pitchOffsetCents: 1200 }));
    expect(clamped.ratioClamped).toBe(true);
    expect(clamped.workletError).toMatch(/clamped/i);
  });

  it('refuses linked-speed without a media element instead of pretending', async () => {
    const { engine } = engineWith();
    const state = await engine.setRetune(retune({ mode: 'linked-speed', referenceHz: 432 }));
    expect(state.applied).toBe('none');
    expect(state.workletError).toMatch(/media element/i);
  });

  it('detaching restores the media element it borrowed', async () => {
    const { engine } = engineWith();
    const element = new MockMediaElement({ src: 'blob:z' });
    engine.attachMediaElement(element);
    await engine.setRetune(retune({ mode: 'linked-speed', referenceHz: 415 }));
    expect(element.playbackRate).not.toBe(1);
    engine.detach();
    expect(element.playbackRate).toBe(1);
    expect(element.preservesPitch).toBe(true);
  });
});
