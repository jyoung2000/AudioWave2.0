/**
 * Main-thread side of the pitch-shifter worklet: load the module once per context and create
 * nodes for it.
 *
 * The app owns the module URL (Vite: `import url from '@now-playing/audio-core/worklets/pitch-shifter?worker&url'`,
 * or `new URL('…/pitch-shifter.worklet.ts', import.meta.url)`), because only the bundler knows
 * where the built file ends up. The engine only ever calls `loadPitchShifterWorklet(ctx, url)`.
 */
import type { EngineContext, WorkletNodeLike, WorkletNodeOptionsLike } from '../types.js';
import { PITCH_SHIFTER_PROCESSOR_NAME, normalizeGrainSize, sanitizeRatio } from './pitch-shifter-core.js';

export type WorkletLoadResult = { ok: true } | { ok: false; reason: string };

export const WORKLET_UNSUPPORTED_REASON = 'AudioWorklet is not supported by this audio context';

/** One in-flight or successful load per context. Failures are dropped so a later call can retry. */
const loads = new WeakMap<EngineContext, Promise<WorkletLoadResult>>();

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

/**
 * Idempotent per context: concurrent and repeated calls share a single `addModule`. The processor
 * name is global to a context, so once a module registered it a second URL is never loaded (the
 * cached success is returned). A rejected load is not cached, so the caller may retry.
 */
export function loadPitchShifterWorklet(context: EngineContext, moduleUrl: string | URL): Promise<WorkletLoadResult> {
  const pending = loads.get(context);
  if (pending) return pending;
  const worklet = context.audioWorklet;
  if (!worklet) return Promise.resolve({ ok: false, reason: WORKLET_UNSUPPORTED_REASON });
  let attempt: Promise<WorkletLoadResult>;
  try {
    attempt = worklet.addModule(moduleUrl).then(
      (): WorkletLoadResult => ({ ok: true }),
      (error: unknown): WorkletLoadResult => {
        loads.delete(context);
        return { ok: false, reason: `Could not load the pitch-shifter worklet from ${String(moduleUrl)}: ${errorMessage(error)}` };
      },
    );
  } catch (error) {
    return Promise.resolve({ ok: false, reason: `Could not load the pitch-shifter worklet from ${String(moduleUrl)}: ${errorMessage(error)}` });
  }
  loads.set(context, attempt);
  return attempt;
}

export interface PitchShifterNodeOptions {
  /** Initial ratio (clamped to MIN_RATIO…MAX_RATIO). Default 1. */
  ratio?: number;
  /** Start bit-exact (bypass = 1) so inserting the node is inaudible. Default `true`. */
  bypass?: boolean;
  /** Grain size in samples (even, ≥ MIN_GRAIN_SIZE); default `defaultGrainSize(sampleRate)`. */
  grainSize?: number;
}

function isBaseAudioContext(context: EngineContext): context is EngineContext & BaseAudioContext {
  const Base = (globalThis as { BaseAudioContext?: typeof BaseAudioContext }).BaseAudioContext;
  return typeof Base === 'function' && context instanceof Base;
}

/**
 * Create the "np-pitch-shifter" node. Uses `context.createWorkletNode` when the context provides
 * it (the mock), otherwise the global `AudioWorkletNode` constructor. Throws when the module has
 * not been loaded (the browser raises InvalidStateError; the mock mirrors it).
 */
export function createPitchShifterNode(context: EngineContext, options: PitchShifterNodeOptions = {}): WorkletNodeLike {
  const nodeOptions: WorkletNodeOptionsLike = {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    parameterData: { ratio: sanitizeRatio(options.ratio ?? 1), bypass: (options.bypass ?? true) ? 1 : 0 },
    ...(options.grainSize === undefined ? {} : { processorOptions: { grainSize: normalizeGrainSize(options.grainSize) } }),
  };
  if (context.createWorkletNode) return context.createWorkletNode(PITCH_SHIFTER_PROCESSOR_NAME, nodeOptions);
  const Ctor = (globalThis as { AudioWorkletNode?: typeof AudioWorkletNode }).AudioWorkletNode;
  if (typeof Ctor !== 'function') throw new Error('AudioWorkletNode is not available in this environment');
  if (!isBaseAudioContext(context)) throw new TypeError('createPitchShifterNode needs a real BaseAudioContext when the context has no createWorkletNode hook');
  return new Ctor(context, PITCH_SHIFTER_PROCESSOR_NAME, nodeOptions);
}
