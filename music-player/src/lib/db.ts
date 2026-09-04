/**
 * Local storage for the player.
 *
 * IndexedDB holds everything the player owns: the track index, playlists, EQ presets and bindings,
 * listening events, and the directory handles the browser lets it keep. Audio *files* are never
 * copied in — a File System Access handle points at the file where it already lives, so a 200 GB
 * library costs kilobytes here.
 *
 * Every store is keyed by a UUIDv7 and carries `updatedAt`/`deletedAt`, which is what makes the
 * whole thing syncable with the hub and the companion without a second representation.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { EqBinding, EqPreset, ListeningEvent, Playlist, PlaylistItem, Track } from '@now-playing/contracts';

export const DB_NAME = 'now-playing';
export const DB_VERSION = 1;

export interface StoredRoot {
  id: string;
  kind: 'directory' | 'files';
  displayName: string;
  /** A FileSystemDirectoryHandle when the browser supports it; absent for one-off file pickers. */
  handle: FileSystemDirectoryHandle | null;
  trackCount: number;
  addedAt: string;
  lastScanAt: string | null;
  lastScanError: string | null;
}

/** A track's file, addressed the way this browser can actually reopen it. */
export interface StoredFileRef {
  trackId: string;
  rootId: string;
  /** Path relative to the root directory, used to re-resolve the handle after a restart. */
  relativePath: string;
  /** Kept only when the browser has no directory handles: the file must be re-picked each session. */
  ephemeral: boolean;
  sizeBytes: number;
  lastModified: number;
}

export interface StoredSetting {
  key: string;
  value: unknown;
  updatedAt: string;
}

interface PlayerDb extends DBSchema {
  tracks: { key: string; value: Track; indexes: { 'by-artist': string; 'by-album': string; 'by-updated': string } };
  roots: { key: string; value: StoredRoot };
  files: { key: string; value: StoredFileRef; indexes: { 'by-root': string } };
  playlists: { key: string; value: Playlist; indexes: { 'by-updated': string } };
  playlistItems: { key: string; value: PlaylistItem; indexes: { 'by-playlist': string } };
  eqPresets: { key: string; value: EqPreset };
  eqBindings: { key: string; value: EqBinding; indexes: { 'by-track': string } };
  events: { key: string; value: ListeningEvent; indexes: { 'by-occurred': string } };
  artwork: { key: string; value: { id: string; blob: Blob; mime: string } };
  settings: { key: string; value: StoredSetting };
}

export type PlayerDatabase = IDBPDatabase<PlayerDb>;

let instance: Promise<PlayerDatabase> | null = null;

export function openPlayerDb(name = DB_NAME): Promise<PlayerDatabase> {
  instance ??= openDB<PlayerDb>(name, DB_VERSION, {
    upgrade(db) {
      const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
      tracks.createIndex('by-artist', 'artistName');
      tracks.createIndex('by-album', 'albumName');
      tracks.createIndex('by-updated', 'updatedAt');

      db.createObjectStore('roots', { keyPath: 'id' });

      const files = db.createObjectStore('files', { keyPath: 'trackId' });
      files.createIndex('by-root', 'rootId');

      const playlists = db.createObjectStore('playlists', { keyPath: 'id' });
      playlists.createIndex('by-updated', 'updatedAt');

      const items = db.createObjectStore('playlistItems', { keyPath: 'id' });
      items.createIndex('by-playlist', 'playlistId');

      db.createObjectStore('eqPresets', { keyPath: 'id' });

      const bindings = db.createObjectStore('eqBindings', { keyPath: 'id' });
      bindings.createIndex('by-track', 'trackId');

      const events = db.createObjectStore('events', { keyPath: 'id' });
      events.createIndex('by-occurred', 'occurredAt');

      db.createObjectStore('artwork', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'key' });
    },
    blocked() {
      // Another tab is holding an older version open. Nothing to do but wait; the UI shows a note.
    },
  });
  return instance;
}

/** Tests open a fresh database per case rather than sharing the module-level one. */
export function resetPlayerDbForTests(): void {
  instance = null;
}

export async function getSetting<T>(db: PlayerDatabase, key: string, fallback: T): Promise<T> {
  const row = await db.get('settings', key);
  return row === undefined ? fallback : (row.value as T);
}

export async function putSetting(db: PlayerDatabase, key: string, value: unknown): Promise<void> {
  await db.put('settings', { key, value, updatedAt: new Date().toISOString() });
}

/** Everything the player holds, for the "delete my data" action and for tests. */
export async function clearEverything(db: PlayerDatabase): Promise<void> {
  const stores = ['tracks', 'roots', 'files', 'playlists', 'playlistItems', 'eqPresets', 'eqBindings', 'events', 'artwork', 'settings'] as const;
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((store) => tx.objectStore(store).clear()));
  await tx.done;
}

/** Live counts for the storage panel, so "what is this using?" has a real answer. */
export async function storageReport(db: PlayerDatabase): Promise<{ tracks: number; playlists: number; events: number; artwork: number; estimateBytes: number | null; quotaBytes: number | null }> {
  const [tracks, playlists, events, artwork] = await Promise.all([db.count('tracks'), db.count('playlists'), db.count('events'), db.count('artwork')]);
  let estimateBytes: number | null = null;
  let quotaBytes: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      estimateBytes = estimate.usage ?? null;
      quotaBytes = estimate.quota ?? null;
    } catch {
      // Firefox in private mode refuses; report unknown rather than guessing.
    }
  }
  return { tracks, playlists, events, artwork, estimateBytes, quotaBytes };
}
