import type { Db } from '../connection.js';

/** Generic JSON key/value store for hub-wide configuration (identity, network, discord, releases, …). */
export class SettingsRepository {
  private readonly getStmt;
  private readonly putStmt;
  private readonly delStmt;
  private readonly allStmt;

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare<[string], { value: string; updated_at: string }>('SELECT value, updated_at FROM settings WHERE key = ?');
    this.putStmt = db.prepare<[string, string, string]>('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    this.delStmt = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
    this.allStmt = db.prepare<[], { key: string; value: string; updated_at: string }>('SELECT key, value, updated_at FROM settings ORDER BY key');
  }

  get<T>(key: string): T | undefined {
    const row = this.getStmt.get(key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  getWithTime<T>(key: string): { value: T; updatedAt: string } | undefined {
    const row = this.getStmt.get(key);
    return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : undefined;
  }

  set<T>(key: string, value: T, now: string): void {
    this.putStmt.run(key, JSON.stringify(value), now);
  }

  delete(key: string): void {
    this.delStmt.run(key);
  }

  all(): Array<{ key: string; value: unknown; updatedAt: string }> {
    return this.allStmt.all().map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown, updatedAt: r.updated_at }));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
