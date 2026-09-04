/**
 * AudioWorkletProcessor wrapper around `PitchShifterCore` (see ADR-0003).
 *
 * Runs inside an AudioWorkletGlobalScope: never import this file on the main thread — it calls
 * `registerProcessor` at load time. It is self-contained for bundling (its only import is the
 * core), so `audioWorklet.addModule(url)` works with a Vite `?worker&url` build, a
 * `new URL('./pitch-shifter.worklet.ts', import.meta.url)` asset, or a plain file URL in Electron.
 *
 * Parameters (k-rate, from `PITCH_SHIFTER_PARAMETER_DESCRIPTORS`): `ratio` 0.5…2 (1 = bit-exact
 * passthrough) and `bypass` 0/1 (≥ 0.5 forces the passthrough). Messages on the port:
 * `{ type: 'reset' }` clears the grain buffers (after a seek); `{ type: 'dispose' }` lets the
 * processor end so the node can be garbage-collected.
 */
import {
  PITCH_SHIFTER_PARAMETER_DESCRIPTORS,
  PITCH_SHIFTER_PROCESSOR_NAME,
  PitchShifterCore,
  defaultGrainSize,
  normalizeGrainSize,
  type PitchShifterParameterDescriptor,
} from './pitch-shifter-core.js';

// lib.dom.d.ts does not describe the AudioWorkletGlobalScope, so the few globals this file uses
// are declared here, module-locally. `declare` statements are erased by tsc/esbuild/Vite.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processorCtor: new (options?: PitchShifterProcessorOptions) => AudioWorkletProcessor): void;

export interface PitchShifterProcessorOptions {
  processorOptions?: { grainSize?: number };
}

export type PitchShifterMessage = { type: 'reset' } | { type: 'dispose' };

function messageType(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): readonly PitchShifterParameterDescriptor[] {
    return PITCH_SHIFTER_PARAMETER_DESCRIPTORS;
  }

  private core: PitchShifterCore | null = null;
  private readonly grainSize: number;
  private alive = true;

  constructor(options?: PitchShifterProcessorOptions) {
    super(options);
    const requested = options?.processorOptions?.grainSize;
    this.grainSize = typeof requested === 'number' && Number.isFinite(requested) ? normalizeGrainSize(requested) : defaultGrainSize(sampleRate);
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const type = messageType(event.data);
      if (type === 'reset') this.core?.reset();
      else if (type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (!this.alive) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || output.length === 0) return true;
    const channels = Math.min(input.length, output.length);
    if (channels === 0) {
      // Nothing connected upstream: the output buffers are already silent.
      return true;
    }
    if (!this.core || this.core.channels !== channels) this.core = new PitchShifterCore(sampleRate, channels, this.grainSize);
    const ratio = parameters.ratio?.[0] ?? 1;
    const bypass = (parameters.bypass?.[0] ?? 0) >= 0.5;
    this.core.process(input, output, ratio, bypass);
    return true;
  }
}

registerProcessor(PITCH_SHIFTER_PROCESSOR_NAME, PitchShifterProcessor);
