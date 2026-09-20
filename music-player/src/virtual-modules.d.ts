/**
 * Modules the bundler synthesises, which therefore have no file on disk to infer types from.
 *
 * `virtual:np-worklet-url` comes from `vite-plugins/worklet.ts`. It carries the URL of the
 * compiled pitch-shifter AudioWorklet in the served build, and null in the single-file build,
 * where the worklet travels as source text in `__NP_WORKLET_SOURCE__` instead.
 */
declare module 'virtual:np-worklet-url' {
  export const workletAssetUrl: string | null;
}
