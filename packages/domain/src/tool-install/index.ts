/**
 * Setting up yt-dlp, FFmpeg and spotDL: one verified installer, used by the local helper (and so
 * the Windows companion) and by the hub. Node only — imported as `@now-playing/domain/tool-install`,
 * never from the package index, which the player bundles for the browser.
 */
export * from './install.js';
export * from './sources.js';
export * from './zip.js';
export * from './probe.js';
