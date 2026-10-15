import type { SavedCatalogItem, SavedCatalogItemRef, SavedCatalogItemList, SavedCatalogTombstone, SavedTrack, Track } from '@now-playing/contracts';
import { SavedCatalogItemList as SavedCatalogItemListSchema, SavedCatalogTombstone as SavedCatalogTombstoneSchema, SavedTrack as SavedTrackSchema } from '@now-playing/contracts';
import { mergeSavedCatalog, savedCatalogKey, savedCatalogRefFromKey } from '@now-playing/domain/catalog';
import type { HubClient } from './hub-client.js';
import { getSetting, putSetting, type PlayerDatabase } from './db.js';
import { savedTrackFromLibraryTrack } from './saved-catalog.js';

const LOCAL_KEY = 'catalog.saved.local';
const RETRY_MAX_MS = 60_000;

interface LocalState {
  tracks: SavedTrack[];
  tombstones: SavedCatalogTombstone[];
}

const emptyLocal = (): LocalState => ({ tracks: [], tombstones: [] });

/** Keeps local song likes and shared stars in one metadata-only, tombstone-aware Hub list. */
export class SavedCatalogSync {
  private local: LocalState = emptyLocal();
  private items: SavedCatalogItem[] = [];
  private listeners = new Set<() => void>();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1_000;
  private unsubscribeHub: (() => void) | null = null;
  private started = false;

  constructor(private readonly db: PlayerDatabase, private readonly hub: HubClient, private readonly tracks: () => readonly Track[]) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly SavedCatalogItem[] => this.items;

  canSync(): boolean {
    return this.hub.hasScope('library:sync');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const saved = await getSetting<unknown>(this.db, LOCAL_KEY, null);
    if (saved && typeof saved === 'object') {
      const raw = saved as Partial<LocalState>;
      this.local = {
        tracks: Array.isArray(raw.tracks) ? raw.tracks.flatMap((item) => { const parsed = SavedTrackSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }) : [],
        tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.flatMap((item) => { const parsed = SavedCatalogTombstoneSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }) : [],
      };
    }
    const known = new Set(this.local.tracks.map((item) => item.identityKey));
    for (const track of this.tracks()) {
      if (!track.liked) continue;
      const item = savedTrackFromLibraryTrack(track);
      if (item && !known.has(item.identityKey)) {
        this.local.tracks.push(item);
        known.add(item.identityKey);
      }
    }
    await this.persist();
    this.publish(this.local.tracks);
    this.unsubscribeHub = this.hub.subscribe((status) => {
      if (status.connected && this.canSync()) void this.sync();
    });
    window.addEventListener('online', this.onOnline);
    if (this.canSync()) await this.sync();
  }

  dispose(): void {
    this.unsubscribeHub?.();
    this.unsubscribeHub = null;
    window.removeEventListener('online', this.onOnline);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.started = false;
  }

  async localLikeChanged(track: Track): Promise<void> {
    const snapshot = savedTrackFromLibraryTrack(track);
    if (!snapshot) return;
    const key = savedCatalogKey(snapshot);
    if (track.liked) {
      const byKey = new Map(this.local.tracks.map((item) => [item.identityKey, item]));
      byKey.set(snapshot.identityKey, snapshot);
      this.local.tracks = [...byKey.values()];
      this.local.tombstones = this.local.tombstones.filter((item) => item.key !== key);
    } else {
      this.local.tracks = this.local.tracks.filter((item) => item.identityKey !== snapshot.identityKey);
      this.local.tombstones = this.local.tombstones.filter((item) => item.key !== key);
      this.local.tombstones.push({ key, at: new Date().toISOString() });
    }
    await this.persist();
    this.publish(mergeSavedCatalog(this.local.tracks, this.items, this.local.tombstones, []).items);
    await this.sync();
  }

  isCatalogTrackSaved(track: SavedTrack): boolean {
    return this.items.some((item) => 'kind' in item && item.kind === 'track' && item.identityKey === track.identityKey);
  }

  async toggleCatalogTrack(item: SavedTrack): Promise<void> {
    if (!this.canSync() || !this.hub.getStatus().connected) throw new Error('Pair with a hub that allows library sync to edit shared stars.');
    const exists = this.items.some((candidate) => 'kind' in candidate && candidate.kind === 'track' && candidate.identityKey === item.identityKey);
    const answer = exists
      ? await this.hub.deleteCatalogItem({ kind: 'track', identityKey: item.identityKey })
      : await this.hub.saveCatalogItem(item);
    this.accept(answer);
  }

  async unstarTrack(identityKey: string): Promise<void> {
    if (!this.canSync() || !this.hub.getStatus().connected) throw new Error('Pair with a hub that allows library sync to edit shared stars.');
    const answer = await this.hub.deleteCatalogItem({ kind: 'track', identityKey });
    this.accept(answer);
  }

  private onOnline = (): void => {
    void this.sync();
  };

  private async persist(): Promise<void> {
    await putSetting(this.db, LOCAL_KEY, this.local);
  }

  private publish(items: readonly SavedCatalogItem[]): void {
    this.items = [...items];
    for (const listener of this.listeners) listener();
  }

  private accept(answer: SavedCatalogItemList): void {
    const parsed = SavedCatalogItemListSchema.parse(answer);
    this.publish(parsed.items);
  }

  private sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = this.syncOnce().finally(() => {
      this.syncing = null;
      if (this.syncAgain) {
        this.syncAgain = false;
        void this.sync();
      }
    });
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    if (!this.canSync() || !this.hub.getStatus().connected) return;
    try {
      const remote = SavedCatalogItemListSchema.parse(await this.hub.savedCatalog());
      const merged = mergeSavedCatalog(this.local.tracks, remote.items, this.local.tombstones, remote.tombstones);
      this.local.tombstones = merged.tombstones;
      this.publish(merged.items);
      await this.persist();
      for (const item of merged.put) {
        const updated = await this.hub.saveCatalogItem(item);
        this.accept(updated);
      }
      for (const tombstone of merged.del) {
        const ref: SavedCatalogItemRef | null = savedCatalogRefFromKey(tombstone.key);
        if (!ref) continue;
        const updated = await this.hub.deleteCatalogItem(ref, tombstone.at);
        this.accept(updated);
        this.local.tombstones = this.local.tombstones.filter((item) => item.key !== tombstone.key);
        await this.persist();
      }
      this.retryMs = 1_000;
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.retryTimer = null;
    } catch {
      // The local like is still available. Retry quietly when the hub returns or the network is back.
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.sync();
      }, this.retryMs);
      this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    }
  }
}
