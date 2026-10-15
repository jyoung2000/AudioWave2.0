import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SavedCollection } from '@now-playing/contracts';
import { SavedCatalogRepository } from '../../src/db/repositories/saved-catalog.js';
import { openDatabase } from '../../src/db/connection.js';
import { defaultMigrationsDir, migrate } from '../../src/db/migrate.js';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('shared catalog-star migration', () => {
  it('preserves legacy albums/playlists and chooses the newest copy across old owners', () => {
    const root = mkdtempSync(join(tmpdir(), 'saved-catalog-migration-'));
    scratch.push(root);
    const oldMigrations = join(root, 'old-migrations');
    const sourceMigrations = defaultMigrationsDir();
    mkdirSync(oldMigrations, { recursive: true });
    const db = openDatabase({ file: join(root, 'hub.sqlite') });
    try {
      // Build the exact v8 schema, as an upgraded installation will have it before 0009.
      const files = readdirSync(sourceMigrations).filter((file) => Number(file.slice(0, 4)) <= 8);
      for (const file of files) copyFileSync(join(sourceMigrations, file), join(oldMigrations, file));
      migrate(db, { migrationsDir: oldMigrations });
      const old = { ref: { platform: 'deezer', kind: 'playlist', id: '9', url: 'https://www.deezer.com/playlist/9', title: 'Old title', owner: null }, savedAt: '2026-10-14T09:00:00.000Z', artworkUrl: null, covers: [], trackCount: 8 };
      const fresh = { ...old, ref: { ...old.ref, title: 'Renamed' }, savedAt: '2026-10-14T10:00:00.000Z' };
      const insert = db.prepare('INSERT INTO saved_collections (owner_id, platform, kind, collection_id, body, saved_at) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('admin:one', 'deezer', 'playlist', '9', JSON.stringify(old), old.savedAt);
      insert.run('device:two', 'deezer', 'playlist', '9', JSON.stringify(fresh), fresh.savedAt);

      migrate(db, { migrationsDir: sourceMigrations });
      const migrated = new SavedCatalogRepository(db).list();
      expect(migrated.items).toHaveLength(1);
      expect(SavedCollection.parse(migrated.items[0])).toMatchObject({ ref: { title: 'Renamed' }, savedAt: fresh.savedAt });
      expect(db.prepare('SELECT COUNT(*) AS n FROM saved_collections').get()).toMatchObject({ n: 2 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM saved_catalog_items WHERE deleted_at IS NULL').get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });
});
