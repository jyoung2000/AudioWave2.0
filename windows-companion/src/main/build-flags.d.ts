/**
 * Values `scripts/build.mjs` substitutes at build time.
 *
 * `__NP_SIGNED__` says whether *this* build was code-signed. It is decided where the answer is
 * known — in CI, from whether a certificate secret exists — rather than read from the environment
 * the app happens to start in on a user's machine, where an unsigned build could have claimed to be
 * signed because someone had exported a variable.
 *
 * Possibly undefined, and read through a `typeof` guard: nothing defines it under Vitest or `tsx`,
 * and a bare reference would throw. Undefined means "not a signed release build", which is true.
 */
declare const __NP_SIGNED__: boolean | undefined;
