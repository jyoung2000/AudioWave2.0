import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_-]+)\.sql$/;

/** Find the migrations directory in dev (repo checkout) and in the bundled dist layout. */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', '..', 'migrations'), join(here, 'migrations'), join(here, '..', 'migrations')];
  for (const c of candidates) if (existsSync(c) && readdirSync(c).some((f) => FILE_RE.test(f))) return c;
  throw new Error(`Could not locate the migrations directory (looked in ${candidates.join(', ')})`);
}

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const out: Migration[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f)!;
    const version = Number(m[1]);
    if (out.some((x) => x.version === version)) throw new Error(`Duplicate migration version ${version}`);
    out.push({ version, name: m[2]!, sql: readFileSync(join(dir, f), 'utf8') });
  }
  return out;
}

export function currentSchemaVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  backupPath: string | null;
}

/**
 * Apply pending migrations inside one transaction each. When the database file already exists and has pending work,
 * a pre-migration copy is written to `backupDir` first so a failed or unwanted upgrade can be rolled back by hand.
 */
export function migrate(db: Db, options: { migrationsDir?: string; dbFile?: string; backupDir?: string; now?: () => number } = {}): MigrateResult {
  const migrations = loadMigrations(options.migrationsDir ?? defaultMigrationsDir());
  const from = currentSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > from);
  let backupPath: string | null = null;
  if (pending.length && options.dbFile && options.dbFile !== ':memory:' && options.backupDir && from > 0 && existsSync(options.dbFile)) {
    mkdirSync(options.backupDir, { recursive: true });
    const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-');
    backupPath = join(options.backupDir, `pre-migration-${stamp}-v${from}.sqlite`);
    // Use the online backup API through a temporary connection-free copy: WAL content is flushed first.
    db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(options.dbFile, backupPath);
  }
  const applied: string[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, new Date(options.now?.() ?? Date.now()).toISOString());
    });
    run();
    applied.push(`${String(m.version).padStart(4, '0')}_${m.name}`);
  }
  return { from, to: pending.length ? pending[pending.length - 1]!.version : from, applied, backupPath };
}
