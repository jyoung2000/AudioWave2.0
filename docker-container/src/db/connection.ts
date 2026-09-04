import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export interface OpenOptions {
  /** ':memory:' for tests. */
  file: string;
  readonly?: boolean;
}

/** Open the hub database with the pragmas documented in ADR-0004. */
export function openDatabase(options: OpenOptions): Db {
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true });
  const db = new Database(options.file, { readonly: options.readonly ?? false, timeout: 5000 });
  if (options.file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  return db;
}

export function walMode(db: Db): boolean {
  const mode = db.pragma('journal_mode', { simple: true });
  return typeof mode === 'string' && mode.toLowerCase() === 'wal';
}

export function checkpoint(db: Db): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* read-only or memory database */
  }
}
