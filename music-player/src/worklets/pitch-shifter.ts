/**
 * AudioWorklet entry for the pitch shifter.
 *
 * This file runs on the audio rendering thread in its own global scope — no DOM, no window. The DSP
 * itself lives in `audio-core` so it can be tested against rendered audio in Node; this file is
 * only the registration shim that makes it available to the graph.
 */
import { PitchShifterCore, PITCH_SHIFTER_PROCESSOR_NAME } from '@now-playing/audio-core';

class PitchShifterProcessor extends AudioWorkletProcessor {
  private core: PitchShifterCore | null = null;
  private bypass = false;

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; bypass?: boolean } | null;
      if (data?.type === 'reset') this.core?.reset();
      if (data?.type === 'bypass' && typeof data.bypass === 'boolean') this.bypass = data.bypass;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    // The channel count is only known once audio flows, so the core is built on the first block.
    this.core ??= new PitchShifterCore(sampleRate, Math.max(1, output.length));
    this.core.process(input, output, parameters['ratio']?.[0] ?? 1, this.bypass);
    // Never return false: the node lives for the life of the graph, and returning false would
    // silently drop it out mid-song.
    return true;
  }
}

registerProcessor(PITCH_SHIFTER_PROCESSOR_NAME, PitchShifterProcessor);
