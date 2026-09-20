/**
 * What `virtual:np-worklet-url` resolves to under Vitest, which runs no bundler plugins.
 *
 * Null is the honest answer: no asset was emitted, so the app falls back the way the single-file
 * build does. The DSP itself is tested directly in `packages/audio-core`, and the served build's
 * asset is proved by `tests/e2e/worklet.spec.ts`.
 */
export const workletAssetUrl: string | null = null;
