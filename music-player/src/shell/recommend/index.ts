/**
 * `window.NP_RECOMMEND` (NP-DISC-001/006/007): the ranker, the online candidates it ranks the same
 * way, and the look-ahead planner — one namespace, so the shell's Discover, the Settings preview and
 * the catalog set can never rank with different arithmetic. Pure functions only; the catalog itself
 * is asked by the search chunk (`shell/search/discover.ts`).
 */
export * from './rank.js';
export * from './online.js';
export * from './prefetch.js';
