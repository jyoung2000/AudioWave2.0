/**
 * Playlists kept in a folder (DEC-041): the `.m3u8` and `.airwave.json` format and a store that
 * reads and writes a folder of them. Node only — imported as `@now-playing/domain/playlist-folder`
 * by the hub and the companion's main process, never from the package index the player bundles.
 */
export * from './format.js';
export * from './store.js';
