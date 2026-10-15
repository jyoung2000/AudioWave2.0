import { CatalogPlatform, type SavedCatalogItem, type SavedCatalogItemRef, type SavedCatalogTombstone } from '@now-playing/contracts';

export function savedCatalogKey(value: SavedCatalogItem | SavedCatalogItemRef): string {
  if ('identityKey' in value) return `track:${value.identityKey}`;
  if ('ref' in value) return `collection:${value.ref.platform}:${value.ref.kind}:${value.ref.id}`;
  return `collection:${value.platform}:${value.kind}:${value.id}`;
}

export function savedCatalogRefFromKey(key: string): SavedCatalogItemRef | null {
  if (key.startsWith('track:')) {
    const identityKey = key.slice('track:'.length);
    return identityKey ? { kind: 'track', identityKey } : null;
  }
  if (!key.startsWith('collection:')) return null;
  const parts = key.slice('collection:'.length).split(':');
  const platform = CatalogPlatform.safeParse(parts.shift());
  const kind = parts.shift();
  const id = parts.join(':');
  if (!platform.success || (kind !== 'album' && kind !== 'playlist') || !id) return null;
  return { platform: platform.data, kind, id };
}

const millis = (iso: string | null | undefined): number => {
  const value = Date.parse(iso ?? '');
  return Number.isFinite(value) ? value : 0;
};

export interface MergeSavedCatalogResult {
  items: SavedCatalogItem[];
  put: SavedCatalogItem[];
  del: SavedCatalogTombstone[];
  tombstones: SavedCatalogTombstone[];
}

/** Merge one offline client with the shared Hub snapshot; title-only tracks never enter this merge. */
export function mergeSavedCatalog(
  local: readonly SavedCatalogItem[],
  remote: readonly SavedCatalogItem[],
  localTombstones: readonly SavedCatalogTombstone[],
  remoteTombstones: readonly SavedCatalogTombstone[],
): MergeSavedCatalogResult {
  const localByKey = new Map(local.map((item) => [savedCatalogKey(item), item]));
  const remoteByKey = new Map(remote.map((item) => [savedCatalogKey(item), item]));
  const localTombs = newestByKey(localTombstones);
  const remoteTombs = newestByKey(remoteTombstones);

  const items: SavedCatalogItem[] = [];
  const put: SavedCatalogItem[] = [];
  const del: SavedCatalogTombstone[] = [];
  const tombstones: SavedCatalogTombstone[] = [];
  const emitted = new Set<string>();

  const emit = (key: string): void => {
    if (emitted.has(key)) return;
    emitted.add(key);
    const here = localByKey.get(key);
    const there = remoteByKey.get(key);
    const localTomb = localTombs.get(key);
    const remoteTomb = remoteTombs.get(key);
    const tomb = !localTomb ? remoteTomb : !remoteTomb ? localTomb : millis(localTomb.at) >= millis(remoteTomb.at) ? localTomb : remoteTomb;
    const chosen = !here ? there : !there ? here : millis(here.savedAt) > millis(there.savedAt) ? here : there;

    if (tomb && (!chosen || millis(tomb.at) >= millis(chosen.savedAt))) {
      // Send a locally-created tombstone even when this Hub has not seen the item. Another offline
      // client may still hold an older copy; persisting the delete here prevents that copy returning.
      if (localTomb && (!remoteTomb || millis(localTomb.at) > millis(remoteTomb.at))) {
        del.push(localTomb);
        tombstones.push(localTomb);
      }
      return;
    }
    if (!chosen) return;
    items.push(chosen);
    if (here && (!there || millis(here.savedAt) > millis(there.savedAt) || (remoteTomb !== undefined && millis(here.savedAt) > millis(remoteTomb.at)))) put.push(here);
  };

  // Keep the caller's existing order, then append remote-only entries oldest first.
  for (const item of local) emit(savedCatalogKey(item));
  const remoteOnly = remote.filter((item) => !localByKey.has(savedCatalogKey(item))).slice().sort((a, b) => millis(a.savedAt) - millis(b.savedAt));
  for (const item of remoteOnly) emit(savedCatalogKey(item));
  for (const key of new Set([...localTombs.keys(), ...remoteTombs.keys()])) if (!emitted.has(key)) emit(key);
  return { items, put, del, tombstones };
}

function newestByKey(rows: readonly SavedCatalogTombstone[]): Map<string, SavedCatalogTombstone> {
  const out = new Map<string, SavedCatalogTombstone>();
  for (const marker of rows) {
    const current = out.get(marker.key);
    if (!current || millis(marker.at) > millis(current.at)) out.set(marker.key, marker);
  }
  return out;
}
