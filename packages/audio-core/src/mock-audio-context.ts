/**
 * Deterministic in-memory Web Audio double for Node tests.
 *
 * It records node creation (`nodes`, in creation order), live connections (`connections`, plus a
 * `log` of every connect/disconnect), every AudioParam automation call with its time, and every
 * direct `.value =` write (`valueWrites`) so tests can prove the engine only ever ramps. Time is
 * explicit: `advance(seconds)` moves `currentTime`; `param.valueAt(t)` evaluates the automation
 * timeline (setValueAtTime, linearRampToValueAtTime, setTargetAtTime, cancelScheduledValues)
 * the way the spec describes it, closely enough for assertions like "settled after the ramp".
 *
 * `MockAudioWorklet.addModule` resolves (registering the pitch-shifter processor name) unless the
 * context was created with `workletLoadError`, in which case it rejects with that reason.
 * `createWorkletNode` throws when the processor was not registered, mirroring the browser's
 * InvalidStateError, so a load/create ordering bug in the engine fails loudly.
 */
import type {
  AnalyserNodeLike,
  AudioBufferLike,
  AudioNodeLike,
  AudioParamLike,
  AudioWorkletLike,
  BiquadFilterNodeLike,
  BufferSourceNodeLike,
  DynamicsCompressorNodeLike,
  EngineContext,
  GainNodeLike,
  MediaElementSourceNodeLike,
  RetunableMediaElement,
  WorkletNodeLike,
  WorkletNodeOptionsLike,
} from './types.js';
import { PITCH_SHIFTER_PARAMETER_DESCRIPTORS, PITCH_SHIFTER_PROCESSOR_NAME } from './worklets/pitch-shifter-core.js';

export type AutomationEvent =
  | { type: 'setValueAtTime'; value: number; time: number }
  | { type: 'linearRampToValueAtTime'; value: number; time: number }
  | { type: 'setTargetAtTime'; value: number; time: number; timeConstant: number };

export interface ValueWrite {
  param: MockAudioParam;
  value: number;
  time: number;
}

export interface ConnectionLogEntry {
  op: 'connect' | 'disconnect';
  from: MockAudioNode;
  to: MockAudioNode | null;
  time: number;
}

const FLOAT32_MAX = 3.4028234663852886e38;

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number, got ${String(value)}`);
}

function assertTime(name: string, time: number): void {
  assertFinite(name, time);
  if (time < 0) throw new RangeError(`${name} must be non-negative, got ${time}`);
}

export class MockAudioParam implements AudioParamLike {
  /** Automation timeline, ordered by time (stable for equal times). */
  readonly events: AutomationEvent[] = [];
  /** Times passed to `cancelScheduledValues`, in call order. */
  readonly cancels: number[] = [];
  /** Values written through the `.value` setter (the engine must never do this while running). */
  readonly valueWrites: number[] = [];
  private intrinsic: number;

  constructor(
    readonly context: MockAudioContext,
    readonly name: string,
    readonly defaultValue: number,
    readonly minValue: number = -FLOAT32_MAX,
    readonly maxValue: number = FLOAT32_MAX,
  ) {
    this.intrinsic = defaultValue;
  }

  get value(): number {
    return this.valueAt(this.context.currentTime);
  }

  set value(v: number) {
    assertFinite(`${this.name}.value`, v);
    this.valueWrites.push(v);
    this.context.valueWrites.push({ param: this, value: v, time: this.context.currentTime });
    this.intrinsic = v;
  }

  /** Set the initial value without recording a write (what `parameterData` does at construction). */
  seed(value: number): void {
    this.intrinsic = value;
  }

  setValueAtTime(value: number, startTime: number): AudioParamLike {
    assertFinite(`${this.name} value`, value);
    assertTime('startTime', startTime);
    this.insert({ type: 'setValueAtTime', value, time: startTime });
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): AudioParamLike {
    assertFinite(`${this.name} value`, value);
    assertTime('endTime', endTime);
    this.insert({ type: 'linearRampToValueAtTime', value, time: endTime });
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): AudioParamLike {
    assertFinite(`${this.name} target`, target);
    assertTime('startTime', startTime);
    assertTime('timeConstant', timeConstant);
    this.insert({ type: 'setTargetAtTime', value: target, time: startTime, timeConstant });
    return this;
  }

  cancelScheduledValues(cancelTime: number): AudioParamLike {
    assertTime('cancelTime', cancelTime);
    this.cancels.push(cancelTime);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.time >= cancelTime) this.events.splice(i, 1);
    return this;
  }

  /** The most recently scheduled event, if any. */
  get lastEvent(): AutomationEvent | undefined {
    return this.events[this.events.length - 1];
  }

  /** Evaluate the automation timeline at `t`. */
  valueAt(t: number): number {
    return this.clampValue(this.evaluate(t, this.events.length));
  }

  private insert(event: AutomationEvent): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.time > event.time) i--;
    this.events.splice(i, 0, event);
  }

  private clampValue(v: number): number {
    return Math.min(this.maxValue, Math.max(this.minValue, v));
  }

  /** Evaluate at `t` considering only events with index < `limit`. */
  private evaluate(t: number, limit: number): number {
    let idx = -1;
    for (let i = 0; i < limit; i++) {
      if (this.events[i]!.time <= t) idx = i;
      else break;
    }
    let v: number;
    let segmentStart: number;
    if (idx < 0) {
      v = this.intrinsic;
      segmentStart = 0;
    } else {
      const e = this.events[idx]!;
      segmentStart = e.time;
      if (e.type === 'setTargetAtTime') {
        const v0 = this.evaluate(e.time, idx);
        v = e.timeConstant <= 0 ? e.value : e.value + (v0 - e.value) * Math.exp(-(t - e.time) / e.timeConstant);
      } else {
        v = e.value;
      }
    }
    const next = idx + 1 < limit ? this.events[idx + 1] : undefined;
    if (next && next.type === 'linearRampToValueAtTime' && next.time > t) {
      const v0 = idx < 0 ? this.intrinsic : this.valueAtEventEnd(idx);
      const span = next.time - segmentStart;
      v = span <= 0 ? next.value : v0 + (next.value - v0) * ((t - segmentStart) / span);
    }
    return v;
  }

  /** Value a ramp starts from: the previous event's own value (its target for setTarget events). */
  private valueAtEventEnd(idx: number): number {
    const e = this.events[idx]!;
    return e.type === 'setTargetAtTime' ? this.evaluate(e.time, idx) : e.value;
  }
}

export type MockNodeKind = 'gain' | 'biquad' | 'compressor' | 'analyser' | 'media-element-source' | 'buffer-source' | 'worklet' | 'destination';

export class MockAudioNode implements AudioNodeLike {
  readonly outputs = new Set<MockAudioNode>();
  readonly inputs = new Set<MockAudioNode>();

  constructor(
    readonly context: MockAudioContext,
    readonly kind: MockNodeKind,
    readonly id: number,
  ) {}

  connect(destination: AudioNodeLike): AudioNodeLike {
    if (!(destination instanceof MockAudioNode)) throw new TypeError('MockAudioNode can only connect to another MockAudioNode');
    if (destination.context !== this.context) throw new Error('InvalidAccessError: nodes belong to different contexts');
    this.outputs.add(destination);
    destination.inputs.add(this);
    this.context.log.push({ op: 'connect', from: this, to: destination, time: this.context.currentTime });
    return destination;
  }

  disconnect(): void;
  disconnect(destination: AudioNodeLike): void;
  disconnect(destination?: AudioNodeLike): void {
    if (destination === undefined) {
      for (const out of this.outputs) out.inputs.delete(this);
      this.outputs.clear();
      this.context.log.push({ op: 'disconnect', from: this, to: null, time: this.context.currentTime });
      return;
    }
    if (!(destination instanceof MockAudioNode) || !this.outputs.has(destination)) {
      throw new Error(`InvalidAccessError: ${this.describe()} is not connected to the given node`);
    }
    this.outputs.delete(destination);
    destination.inputs.delete(this);
    this.context.log.push({ op: 'disconnect', from: this, to: destination, time: this.context.currentTime });
  }

  /** `true` when this node feeds `other` directly. */
  isConnectedTo(other: MockAudioNode): boolean {
    return this.outputs.has(other);
  }

  describe(): string {
    return `${this.kind}#${this.id}`;
  }
}

export class MockDestinationNode extends MockAudioNode {
  readonly maxChannelCount = 2;
}

export class MockGainNode extends MockAudioNode implements GainNodeLike {
  readonly gain: MockAudioParam;
  constructor(context: MockAudioContext, id: number) {
    super(context, 'gain', id);
    this.gain = new MockAudioParam(context, `gain#${id}.gain`, 1);
  }
}

export class MockBiquadFilterNode extends MockAudioNode implements BiquadFilterNodeLike {
  type: BiquadFilterType = 'lowpass';
  readonly frequency: MockAudioParam;
  readonly Q: MockAudioParam;
  readonly gain: MockAudioParam;
  constructor(context: MockAudioContext, id: number) {
    super(context, 'biquad', id);
    this.frequency = new MockAudioParam(context, `biquad#${id}.frequency`, 350, 0, context.sampleRate / 2);
    this.Q = new MockAudioParam(context, `biquad#${id}.Q`, 1);
    this.gain = new MockAudioParam(context, `biquad#${id}.gain`, 0);
  }
}

export class MockDynamicsCompressorNode extends MockAudioNode implements DynamicsCompressorNodeLike {
  readonly threshold: MockAudioParam;
  readonly knee: MockAudioParam;
  readonly ratio: MockAudioParam;
  readonly attack: MockAudioParam;
  readonly release: MockAudioParam;
  readonly reduction = 0;
  constructor(context: MockAudioContext, id: number) {
    super(context, 'compressor', id);
    this.threshold = new MockAudioParam(context, `compressor#${id}.threshold`, -24, -100, 0);
    this.knee = new MockAudioParam(context, `compressor#${id}.knee`, 30, 0, 40);
    this.ratio = new MockAudioParam(context, `compressor#${id}.ratio`, 12, 1, 20);
    this.attack = new MockAudioParam(context, `compressor#${id}.attack`, 0.003, 0, 1);
    this.release = new MockAudioParam(context, `compressor#${id}.release`, 0.25, 0, 1);
  }
}

export class MockAnalyserNode extends MockAudioNode implements AnalyserNodeLike {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  /** Bytes returned by `getByteFrequencyData`, cycled to fill the target; set with `setFrequencyData`. */
  private frequencyPattern: Uint8Array = Uint8Array.from([0, 64, 128, 192, 255]);
  private timeDomainPattern: Uint8Array = Uint8Array.from([128]);
  constructor(context: MockAudioContext, id: number) {
    super(context, 'analyser', id);
  }
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  setFrequencyData(bytes: ArrayLike<number>): void {
    this.frequencyPattern = Uint8Array.from(bytes);
  }
  setTimeDomainData(bytes: ArrayLike<number>): void {
    this.timeDomainPattern = Uint8Array.from(bytes);
  }
  getByteFrequencyData(array: Uint8Array<ArrayBuffer>): void {
    fillCyclic(array, this.frequencyPattern);
  }
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void {
    fillCyclic(array, this.timeDomainPattern);
  }
}

function fillCyclic(target: Uint8Array, pattern: Uint8Array): void {
  if (pattern.length === 0) {
    target.fill(0);
    return;
  }
  for (let i = 0; i < target.length; i++) target[i] = pattern[i % pattern.length]!;
}

export class MockMediaElementSourceNode extends MockAudioNode implements MediaElementSourceNodeLike {
  constructor(
    context: MockAudioContext,
    id: number,
    readonly mediaElement: RetunableMediaElement,
  ) {
    super(context, 'media-element-source', id);
  }
}

export class MockBufferSourceNode extends MockAudioNode implements BufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly playbackRate: MockAudioParam;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  constructor(context: MockAudioContext, id: number) {
    super(context, 'buffer-source', id);
    this.playbackRate = new MockAudioParam(context, `buffer-source#${id}.playbackRate`, 1);
  }
  start(when = this.context.currentTime): void {
    if (this.startedAt !== null) throw new Error('InvalidStateError: cannot call start more than once');
    this.startedAt = when;
  }
  stop(when = this.context.currentTime): void {
    if (this.startedAt === null) throw new Error('InvalidStateError: cannot call stop without calling start first');
    this.stoppedAt = when;
  }
}

export class MockMessagePort {
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

export class MockWorkletNode extends MockAudioNode implements WorkletNodeLike {
  readonly parameters: Map<string, MockAudioParam>;
  readonly port = new MockMessagePort();
  constructor(
    context: MockAudioContext,
    id: number,
    readonly name: string,
    readonly options: WorkletNodeOptionsLike,
  ) {
    super(context, 'worklet', id);
    this.parameters = new Map();
    if (name === PITCH_SHIFTER_PROCESSOR_NAME) {
      for (const d of PITCH_SHIFTER_PARAMETER_DESCRIPTORS) this.parameters.set(d.name, new MockAudioParam(context, `worklet#${id}.${d.name}`, d.defaultValue, d.minValue, d.maxValue));
    }
    for (const [key, value] of Object.entries(options.parameterData ?? {})) {
      const existing = this.parameters.get(key);
      if (existing) existing.seed(value);
      else this.parameters.set(key, new MockAudioParam(context, `worklet#${id}.${key}`, value));
    }
  }
}

export class MockAudioWorklet implements AudioWorkletLike {
  /** URLs passed to `addModule`, in call order (including rejected attempts). */
  readonly addedModules: string[] = [];
  constructor(private readonly context: MockAudioContext) {}
  addModule(moduleUrl: string | URL): Promise<void> {
    this.addedModules.push(String(moduleUrl));
    const failure = this.context.workletLoadError;
    if (failure !== null) return Promise.reject(new Error(failure));
    this.context.registeredProcessors.add(PITCH_SHIFTER_PROCESSOR_NAME);
    return Promise.resolve();
  }
}

export interface MockAudioContextOptions {
  sampleRate?: number;
  state?: AudioContextState;
  /** Seconds; default 0.005. */
  baseLatency?: number;
  /** Seconds; `null` leaves `outputLatency` undefined (a browser that does not expose it). Default 0.02. */
  outputLatency?: number | null;
  /** `false` simulates a context without AudioWorklet support. Default `true`. */
  audioWorklet?: boolean;
  /** When set, `audioWorklet.addModule` rejects with this message. */
  workletLoadError?: string | null;
}

export class MockAudioContext implements EngineContext {
  currentTime = 0;
  state: AudioContextState;
  readonly sampleRate: number;
  readonly destination: MockDestinationNode;
  readonly baseLatency: number;
  readonly outputLatency?: number;
  readonly audioWorklet?: MockAudioWorklet;
  /** Every node created, in creation order. */
  readonly nodes: MockAudioNode[] = [];
  readonly log: ConnectionLogEntry[] = [];
  readonly valueWrites: ValueWrite[] = [];
  readonly registeredProcessors = new Set<string>();
  workletLoadError: string | null;
  private readonly listeners = new Set<() => void>();
  private nextId = 1;

  constructor(options: MockAudioContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.state = options.state ?? 'running';
    this.baseLatency = options.baseLatency ?? 0.005;
    if (options.outputLatency !== null) this.outputLatency = options.outputLatency ?? 0.02;
    if (options.audioWorklet ?? true) this.audioWorklet = new MockAudioWorklet(this);
    this.workletLoadError = options.workletLoadError ?? null;
    this.destination = this.register(new MockDestinationNode(this, 'destination', this.nextId++));
  }

  private register<T extends MockAudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  /** Advance the clock; automation scheduled before the new time is considered rendered. */
  advance(seconds: number): void {
    assertTime('seconds', seconds);
    this.currentTime += seconds;
  }

  createGain(): MockGainNode {
    return this.register(new MockGainNode(this, this.nextId++));
  }

  createBiquadFilter(): MockBiquadFilterNode {
    return this.register(new MockBiquadFilterNode(this, this.nextId++));
  }

  createDynamicsCompressor(): MockDynamicsCompressorNode {
    return this.register(new MockDynamicsCompressorNode(this, this.nextId++));
  }

  createAnalyser(): MockAnalyserNode {
    return this.register(new MockAnalyserNode(this, this.nextId++));
  }

  createMediaElementSource(element: RetunableMediaElement): MockMediaElementSourceNode {
    for (const node of this.nodes) {
      if (node instanceof MockMediaElementSourceNode && node.mediaElement === element) {
        throw new Error('InvalidStateError: HTMLMediaElement already connected previously to a different MediaElementSourceNode');
      }
    }
    return this.register(new MockMediaElementSourceNode(this, this.nextId++, element));
  }

  createBufferSource(): MockBufferSourceNode {
    return this.register(new MockBufferSourceNode(this, this.nextId++));
  }

  createWorkletNode(name: string, options: WorkletNodeOptionsLike = {}): MockWorkletNode {
    if (!this.registeredProcessors.has(name)) throw new Error(`InvalidStateError: AudioWorkletProcessor "${name}" is not registered (audioWorklet.addModule first)`);
    return this.register(new MockWorkletNode(this, this.nextId++, name, options));
  }

  resume(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: context is closed'));
    this.setState('running');
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('InvalidStateError: context is closed'));
    this.setState('suspended');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }

  addEventListener(type: 'statechange', listener: () => void): void {
    if (type === 'statechange') this.listeners.add(listener);
  }

  removeEventListener(type: 'statechange', listener: () => void): void {
    if (type === 'statechange') this.listeners.delete(listener);
  }

  private setState(state: AudioContextState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  /** Live edges (from → to) across every node. */
  get connections(): Array<{ from: MockAudioNode; to: MockAudioNode }> {
    const edges: Array<{ from: MockAudioNode; to: MockAudioNode }> = [];
    for (const from of this.nodes) for (const to of from.outputs) edges.push({ from, to });
    return edges;
  }

  nodesOfKind<K extends MockNodeKind>(kind: K): MockAudioNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  /** Every acyclic path from `from` to `to`, each as the ordered list of nodes (inclusive). */
  allPaths(from: MockAudioNode, to: MockAudioNode): MockAudioNode[][] {
    const paths: MockAudioNode[][] = [];
    const walk = (node: MockAudioNode, trail: MockAudioNode[]): void => {
      if (node === to) {
        paths.push([...trail, node]);
        return;
      }
      if (trail.includes(node)) return;
      for (const next of node.outputs) walk(next, [...trail, node]);
    };
    walk(from, []);
    return paths;
  }

  /** `true` when some path leads from `from` to `to`. */
  reaches(from: MockAudioNode, to: MockAudioNode): boolean {
    const seen = new Set<MockAudioNode>();
    const stack = [from];
    while (stack.length) {
      const node = stack.pop()!;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of node.outputs) stack.push(next);
    }
    return false;
  }
}

export interface MockMediaElementInit {
  src?: string;
  crossOrigin?: string | null;
  srcObject?: unknown;
  playbackRate?: number;
  preservesPitch?: boolean;
  paused?: boolean;
}

/** An `HTMLMediaElement` stand-in exposing exactly what the engine and the retune code touch. */
export class MockMediaElement implements RetunableMediaElement {
  preservesPitch: boolean;
  src: string;
  crossOrigin: string | null;
  srcObject: unknown;
  paused: boolean;
  /** Every value assigned to `playbackRate`, in order (the engine only assigns changed values). */
  readonly rateHistory: number[] = [];
  private rate: number;

  constructor(init: MockMediaElementInit = {}) {
    this.src = init.src ?? '';
    this.crossOrigin = init.crossOrigin ?? null;
    this.srcObject = init.srcObject ?? null;
    this.paused = init.paused ?? true;
    this.preservesPitch = init.preservesPitch ?? true;
    this.rate = init.playbackRate ?? 1;
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(value: number) {
    assertFinite('playbackRate', value);
    this.rate = value;
    this.rateHistory.push(value);
  }

  get currentSrc(): string {
    return this.src;
  }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}
