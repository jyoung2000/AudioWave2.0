/**
 * Values the bundler substitutes at build time.
 *
 * `__NP_SINGLE_FILE__` is true only in the `vite.config.local.ts` build — the one `now-playing.html`
 * that runs from `file://`. `__NP_WORKLET_SOURCE__` carries the compiled AudioWorklet as text, so
 * that build can hand the audio thread a `data:` URL instead of a URL it would have to fetch.
 *
 * Both are declared as possibly-undefined and read through `buildFlags()`, because in the served
 * build, in dev and under Vitest nothing defines them and a bare reference would throw.
 */
declare const __NP_SINGLE_FILE__: boolean | undefined;
declare const __NP_WORKLET_SOURCE__: string | undefined;
