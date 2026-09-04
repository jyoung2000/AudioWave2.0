/**
 * AudioWorklet global scope.
 *
 * TypeScript's DOM library describes the *main* thread. A worklet runs in `AudioWorkletGlobalScope`,
 * which has `registerProcessor`, `sampleRate` and `AudioWorkletProcessor` but no `window` or
 * `document`. These declarations describe only what this worklet actually uses.
 */
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;

interface AudioParamDescriptor {
  name: string;
  automationRate?: 'a-rate' | 'k-rate';
  minValue?: number;
  maxValue?: number;
  defaultValue?: number;
}

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new (options?: unknown) => AudioWorkletProcessor): void;
