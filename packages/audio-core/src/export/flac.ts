/**
 * A FLAC encoder, written here rather than imported.
 *
 * The player has to work with no network and no server, and its bundle
 * budget is measured in kilobytes, so pulling in a codec was not an option —
 * and converting a file you own into a lossless format is a small enough
 * piece of the specification to write directly: a stream header, then frames
 * of fixed-predictor residuals under Rice coding. There is no LPC analysis
 * here and no exhaustive search; FLAC's five fixed predictors get most of the
 * compression an encoder at default settings would, on a fraction of the
 * code, and the output is ordinary FLAC that any decoder reads.
 *
 * What it does not do is guess. The encoder never rounds, never resamples and
 * never drops a channel: what comes out decodes back to the integers that
 * went in, which is the only thing "lossless" can mean. The tests check that
 * against the browser's own decoder rather than against this file's idea of
 * what it wrote.
 */
import { BitWriter, crc8, crc16, writeUtf8Number } from './bits.js';
import { frameCount, toInt, type BitDepth, type PcmSource } from './pcm.js';

/** Inter-channel samples per frame. 4096 is what every encoder uses by default. */
const BLOCK_SIZE = 4096;
/** FLAC's fixed predictors run to order 4. */
const MAX_FIXED_ORDER = 4;
/** How finely a block may be split for Rice coding. 2^6 partitions is plenty at 4096. */
const MAX_PARTITION_ORDER = 6;

const SAMPLE_RATE_CODES = new Map<number, number>([
  [88200, 0b0001],
  [176400, 0b0010],
  [192000, 0b0011],
  [8000, 0b0100],
  [16000, 0b0101],
  [22050, 0b0110],
  [24000, 0b0111],
  [32000, 0b1000],
  [44100, 0b1001],
  [48000, 0b1010],
  [96000, 0b1011],
]);

const BIT_DEPTH_CODES = new Map<BitDepth, number>([
  [16, 0b100],
  [24, 0b110],
]);

/** Residuals for a fixed predictor of the given order, over one channel's block. */
function residualsFor(block: Int32Array, order: number): Int32Array {
  const out = new Int32Array(block.length - order);
  for (let i = order; i < block.length; i += 1) {
    const x = block[i]!;
    switch (order) {
      case 0:
        out[i - order] = x;
        break;
      case 1:
        out[i - order] = x - block[i - 1]!;
        break;
      case 2:
        out[i - order] = x - 2 * block[i - 1]! + block[i - 2]!;
        break;
      case 3:
        out[i - order] = x - 3 * block[i - 1]! + 3 * block[i - 2]! - block[i - 3]!;
        break;
      default:
        out[i - order] = x - 4 * block[i - 1]! + 6 * block[i - 2]! - 4 * block[i - 3]! + block[i - 4]!;
        break;
    }
  }
  return out;
}

/** FLAC folds a signed residual into an unsigned one before Rice coding it. */
function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

/** The Rice parameter that spends the fewest bits on this run of residuals. */
function bestRiceParameter(residuals: Int32Array, from: number, to: number, maxParameter: number): { parameter: number; bits: number } {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += zigzag(residuals[i]!);
  const count = to - from;
  let best = { parameter: 0, bits: Number.POSITIVE_INFINITY };
  for (let k = 0; k <= maxParameter; k += 1) {
    // Each residual costs its quotient in unary, a stop bit, and k remainder bits.
    const divisor = 2 ** k;
    let bits = count * (k + 1);
    for (let i = from; i < to; i += 1) bits += Math.floor(zigzag(residuals[i]!) / divisor);
    if (bits < best.bits) best = { parameter: k, bits };
    // Once the quotients are down to nothing, a larger k only adds remainder bits.
    if (sum / count < divisor) break;
  }
  return best;
}

interface RicePlan {
  partitionOrder: number;
  parameters: number[];
  /** Total bits for the residual section, including the parameter fields. */
  bits: number;
  /** 4-bit parameters (method 0) unless one of them needs 5 (method 1). */
  method: 0 | 1;
}

/**
 * Split the residuals into partitions and pick a Rice parameter for each.
 *
 * A quiet passage and a loud one in the same block want different parameters;
 * partitioning is how FLAC gives them one each. The best split is found by
 * trying each order and keeping the cheapest, which is what the reference
 * encoder does too.
 */
function planRice(residuals: Int32Array, blockSize: number, predictorOrder: number): RicePlan | null {
  let best: RicePlan | null = null;
  for (let order = 0; order <= MAX_PARTITION_ORDER; order += 1) {
    const partitions = 1 << order;
    if (blockSize % partitions !== 0) continue;
    const perPartition = blockSize / partitions;
    // The first partition gives up its warmup samples, so it must have some left.
    if (perPartition <= predictorOrder) continue;

    const parameters: number[] = [];
    let bits = 0;
    let method: 0 | 1 = 0;
    let at = 0;
    let usable = true;
    for (let p = 0; p < partitions; p += 1) {
      const count = p === 0 ? perPartition - predictorOrder : perPartition;
      const chosen = bestRiceParameter(residuals, at, at + count, 30);
      if (!Number.isFinite(chosen.bits)) {
        usable = false;
        break;
      }
      if (chosen.parameter > 14) method = 1;
      parameters.push(chosen.parameter);
      bits += chosen.bits;
      at += count;
    }
    if (!usable) continue;
    // 15 and 31 are escape codes, so a parameter that high cannot be spelled.
    if (parameters.some((k) => (method === 0 ? k >= 15 : k >= 31))) continue;
    bits += partitions * (method === 0 ? 4 : 5) + 2 + 4; // parameters, method, partition order
    if (!best || bits < best.bits) best = { partitionOrder: order, parameters, bits, method };
  }
  return best;
}

function writeResiduals(writer: BitWriter, residuals: Int32Array, plan: RicePlan, blockSize: number, predictorOrder: number): void {
  writer.write(plan.method, 2);
  writer.write(plan.partitionOrder, 4);
  const partitions = 1 << plan.partitionOrder;
  const perPartition = blockSize / partitions;
  let at = 0;
  for (let p = 0; p < partitions; p += 1) {
    const k = plan.parameters[p]!;
    writer.write(k, plan.method === 0 ? 4 : 5);
    const count = p === 0 ? perPartition - predictorOrder : perPartition;
    const divisor = 2 ** k;
    for (let i = 0; i < count; i += 1) {
      const folded = zigzag(residuals[at + i]!);
      writer.writeUnary(Math.floor(folded / divisor));
      if (k > 0) writer.write(folded % divisor, k);
    }
    at += count;
  }
}

/** One channel of one frame. */
function writeSubframe(writer: BitWriter, block: Int32Array, depth: BitDepth): void {
  writer.write(0, 1); // the leading zero every subframe header starts with

  // A run of identical samples — digital silence, most often — is one number.
  let constant = true;
  for (let i = 1; i < block.length; i += 1) {
    if (block[i] !== block[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    writer.write(0b000000, 6);
    writer.write(0, 1); // no wasted bits
    writer.writeSigned(block[0] ?? 0, depth);
    return;
  }

  let chosen: { order: number; residuals: Int32Array; plan: RicePlan; bits: number } | null = null;
  const maxOrder = Math.min(MAX_FIXED_ORDER, block.length - 1);
  for (let order = 0; order <= maxOrder; order += 1) {
    const residuals = residualsFor(block, order);
    const plan = planRice(residuals, block.length, order);
    if (!plan) continue;
    const bits = plan.bits + order * depth + 6 + 1 + 1;
    if (!chosen || bits < chosen.bits) chosen = { order, residuals, plan, bits };
  }

  // Verbatim costs the samples raw; if no predictor beat that, say so plainly.
  const verbatimBits = block.length * depth + 6 + 1 + 1;
  if (!chosen || chosen.bits >= verbatimBits) {
    writer.write(0b000001, 6);
    writer.write(0, 1);
    for (const sample of block) writer.writeSigned(sample, depth);
    return;
  }

  writer.write(0b001000 | chosen.order, 6);
  writer.write(0, 1);
  for (let i = 0; i < chosen.order; i += 1) writer.writeSigned(block[i]!, depth);
  writeResiduals(writer, chosen.residuals, chosen.plan, block.length, chosen.order);
}

function frameHeader(frameNumber: number, blockSize: number, sampleRate: number, channels: number, depth: BitDepth): Uint8Array {
  const writer = new BitWriter();
  writer.write(0b11111111111110, 14); // sync
  writer.write(0, 1); // reserved
  writer.write(0, 1); // fixed blocksize: frames are numbered, not sample-addressed

  // 0b0111 says "the real size follows as 16 bits", which covers every block
  // including the short last one without a table of special cases.
  const blockSizeCode = blockSize === BLOCK_SIZE ? 0b1100 : 0b0111;
  writer.write(blockSizeCode, 4);
  const rateCode = SAMPLE_RATE_CODES.get(sampleRate) ?? 0;
  writer.write(rateCode, 4);
  writer.write(channels - 1, 4); // independent channels; no stereo decorrelation
  writer.write(BIT_DEPTH_CODES.get(depth) ?? 0, 3);
  writer.write(0, 1); // reserved
  writeUtf8Number(writer, frameNumber);
  if (blockSizeCode === 0b0111) writer.write(blockSize - 1, 16);
  const header = writer.toBytes();
  const withCrc = new Uint8Array(header.length + 1);
  withCrc.set(header);
  withCrc[header.length] = crc8(header);
  return withCrc;
}

export interface FlacOptions {
  depth?: BitDepth;
}

/**
 * Encode interleaved float channels as a FLAC stream.
 *
 * The sample rate has to be one FLAC can address. Every rate a browser
 * decodes to is, but the check is here rather than producing a file that
 * claims the wrong speed.
 */
export function encodeFlac(source: PcmSource, options: FlacOptions = {}): Uint8Array {
  const depth = options.depth ?? 24;
  const channels = source.channels.length;
  const frames = frameCount(source);
  if (channels < 1 || channels > 8) throw new RangeError(`FLAC carries 1 to 8 channels, not ${channels}`);
  if (!SAMPLE_RATE_CODES.has(source.sampleRate)) {
    throw new RangeError(`${source.sampleRate} Hz is not one of the sample rates a FLAC frame header can name`);
  }

  const chunks: Uint8Array[] = [];
  let minFrameSize = Number.POSITIVE_INFINITY;
  let maxFrameSize = 0;
  let minBlockSize = Number.POSITIVE_INFINITY;
  let maxBlockSize = 0;

  const blocks = Math.ceil(frames / BLOCK_SIZE);
  for (let b = 0; b < blocks; b += 1) {
    const start = b * BLOCK_SIZE;
    const size = Math.min(BLOCK_SIZE, frames - start);
    const header = frameHeader(b, size, source.sampleRate, channels, depth);

    const body = new BitWriter();
    for (let c = 0; c < channels; c += 1) {
      const channel = source.channels[c]!;
      const block = new Int32Array(size);
      for (let i = 0; i < size; i += 1) block[i] = toInt(channel[start + i]!, depth);
      writeSubframe(body, block, depth);
    }
    const bodyBytes = body.toBytes();

    const frame = new Uint8Array(header.length + bodyBytes.length + 2);
    frame.set(header);
    frame.set(bodyBytes, header.length);
    const crc = crc16(frame.subarray(0, header.length + bodyBytes.length));
    frame[frame.length - 2] = (crc >> 8) & 0xff;
    frame[frame.length - 1] = crc & 0xff;

    chunks.push(frame);
    minFrameSize = Math.min(minFrameSize, frame.length);
    maxFrameSize = Math.max(maxFrameSize, frame.length);
    minBlockSize = Math.min(minBlockSize, size);
    maxBlockSize = Math.max(maxBlockSize, size);
  }

  const head = new BitWriter();
  for (const ch of 'fLaC') head.write(ch.charCodeAt(0), 8);
  head.write(1, 1); // this is the last metadata block
  head.write(0, 7); // STREAMINFO
  head.write(34, 24); // its length
  head.write(Number.isFinite(minBlockSize) ? minBlockSize : 0, 16);
  head.write(maxBlockSize, 16);
  head.write(Number.isFinite(minFrameSize) ? minFrameSize : 0, 24);
  head.write(maxFrameSize, 24);
  head.write(source.sampleRate, 20);
  head.write(channels - 1, 3);
  head.write(depth - 1, 5);
  head.write(frames, 36);
  // The MD5 of the unencoded audio. All zeros is the spec's "not computed",
  // which is honest: nothing here would be able to check it anyway.
  for (let i = 0; i < 16; i += 1) head.write(0, 8);
  const streamInfo = head.toBytes();

  const total = streamInfo.length + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(streamInfo);
  let at = streamInfo.length;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
