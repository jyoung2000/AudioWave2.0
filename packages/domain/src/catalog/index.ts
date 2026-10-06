/**
 * `@now-playing/domain/catalog` — music search across the keyless services (DEC-039).
 *
 * Pure TypeScript: the network is injected (`CatalogFetch`), processes are the server's
 * (`ToolSearchRunner`, `LinkReader`), so the player can import the parts it runs itself.
 */
export * from './http.js';
export * from './limits.js';
export * from './query.js';
export * from './merge.js';
export * from './provider.js';
export * from './links.js';
export * from './services.js';
export * from './providers/itunes.js';
export * from './providers/deezer.js';
export * from './providers/musicbrainz.js';
export * from './providers/ytdlp.js';
export * from './engine.js';
export * from './ndjson.js';
