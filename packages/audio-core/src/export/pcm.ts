/**
 * Shared ground for the encoders: interleaved float channels in, integer
 * samples out.
 *
 * Everything the browser decodes arrives as Float32 in [-1, 1). Both encoders
 * want signed integers, and both want them quantised the same way, so the
 * conversion lives here once rather than twice with a subtle difference
 * between them.
 */

export interface PcmSource {
  /** One Float32Array per channel, all the same length. */
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
}

export type BitDepth = 16 | 24;

export function frameCount(source: PcmSource): number {
  return source.channels[0]?.length ?? 0;
}

/**
 * Float to signed integer, clamped.
 *
 * Scaling by 2^(n-1) and clamping to the positive maximum is what every
 * encoder does: -1.0 maps to the most negative value exactly, and +1.0 would
 * map one past the most positive, so it is held at the maximum instead. A
 * float that never reaches ±1 (which is most music) is unaffected by either.
 */
export function toInt(sample: number, depth: BitDepth): number {
  const peak = 1 << (depth - 1);
  const scaled = Math.round(sample * peak);
  return scaled >= peak ? peak - 1 : scaled < -peak ? -peak : scaled;
}
