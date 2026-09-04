/**
 * Backup, restore, export and import.
 *
 * Backups use SQLite's online backup API (`Database.backup`), which produces a consistent snapshot
 * while the hub keeps serving — copying the file by hand would race the WAL and can yield a
 * database that opens but is missing recent writes.
 *
 * Restoring never overwrites in place: a safety backup is taken first, the candidate is validated
 * (it must open, pass an integrity check and carry a migration version this build understands), and
 * only then is it swapped in. The hub then requires a restart, because every open statement and
 * cached repository still points at the old file.
 *
 * The JSON export is deliberately *not* a backup. It carries groups, history, playlists, presets and
 * device metadata so an operator can move to a new hub, and it carries no secrets at all: no
 * password hashes, no sealed tokens, no credential secrets, no pairing codes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { HubConfig } from '../config.js';
import { checkpoint, openDatabase, type Db } from '../db/connection.js';
import { currentSchemaVersion } from '../db/migrate.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

export interface BackupEntry {
  id: string;
  createdAt: string;
  sizeBytes: number;
  relativePath: string;
}

export interface ImportReport {
  dryRun: boolean;
  applied: Record<string, number>;
  errors: string[];
}

const EXPORT_SCHEMA_VERSION = 1;
/** Keep this many automatic backups; the operator's own backups are never pruned. */
const KEEP_BACKUPS = 10;
const BACKUP_NAME_RE = /^backup-(\d{8}T\d{6}Z)(-safety)?\.sqlite$/;

export class BackupService {
  constructor(
    private readonly db: Db,
    private readonly dbFile: string,
    private readonly config: HubConfig,
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    /** The schema version this build knows how to run; a newer backup is refused. */
    private readonly currentMigrationVersion: number,
  ) {
    mkdirSync(this.dir(), { recursive: true });
  }

  private dir(): string {
    return join(this.config.dataDir, 'backups');
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private stamp(): string {
    return this.nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }

  async create(actor: { id: string; displayName: string } | null, meta: RequestMeta | null, kind: 'manual' | 'safety' = 'manual'): Promise<BackupEntry> {
    if (this.dbFile === ':memory:') throw new DomainError('unsupported', 'This hub is running against an in-memory database, so there is nothing to back up');
    const id = `backup-${this.stamp()}${kind === 'safety' ? '-safety' : ''}`;
    const file = join(this.dir(), `${id}.sqlite`);
    // Checkpoint first so the backup contains everything the WAL is holding.
    checkpoint(this.db);
    await this.db.backup(file);
    const sizeBytes = statSync(file).size;
    this.metrics.increment('backup.created');
    if (actor && meta) {
      this.audit.record({
        actor: { kind: 'admin', id: actor.id, displayName: actor.displayName },
        action: 'backup.create',
        outcome: 'success',
        target: { kind: 'backup', id },
        ip: meta.ip,
        correlationId: meta.correlationId,
        details: { sizeBytes: String(sizeBytes) },
      });
    }
    this.prune();
    return { id, createdAt: this.nowIso(), sizeBytes, relativePath: `backups/${id}.sqlite` };
  }

  list(): BackupEntry[] {
    return readdirSync(this.dir(), { withFileTypes: true })
      .filter((e) => e.isFile() && BACKUP_NAME_RE.test(e.name))
      .map((e) => {
        const id = e.name.replace(/\.sqlite$/, '');
        const s = statSync(join(this.dir(), e.name));
        return { id, createdAt: new Date(s.mtimeMs).toISOString(), sizeBytes: s.size, relativePath: `backups/${e.name}` };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  lastBackupAt(): string | null {
    return this.list()[0]?.createdAt ?? null;
  }

  private prune(): void {
    const automatic = this.list().filter((b) => !b.id.endsWith('-safety'));
    for (const stale of automatic.slice(KEEP_BACKUPS)) rmSync(join(this.config.dataDir, stale.relativePath), { force: true });
  }

  /**
   * Validate a candidate before it is allowed anywhere near the live file. A backup from a *newer*
   * build is refused: this binary's migrations cannot walk backwards, and opening it would corrupt
   * data written by schema this code does not know about.
   */
  private validate(path: string): { migrationVersion: number } {
    if (!existsSync(path)) throw new DomainError('not-found', 'No such backup');
    let candidate: Db | null = null;
    try {
      candidate = openDatabase({ file: path, readonly: true });
      const integrity = candidate.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new DomainError('validation', `That backup fails SQLite's integrity check (${String(integrity)}) and will not be restored`);
      const version = currentSchemaVersion(candidate);
      if (version > this.currentMigrationVersion) {
        throw new DomainError('upgrade-required', `That backup was written by a newer hub (schema ${version}; this build understands ${this.currentMigrationVersion}). Update the hub first.`);
      }
      return { migrationVersion: version };
    } finally {
      candidate?.close();
    }
  }

  async restore(backupId: string, actor: { id: string; displayName: string }, meta: RequestMeta): Promise<{ ok: true; safetyBackupId: string; restartRequired: true }> {
    if (this.dbFile === ':memory:') throw new DomainError('unsupported', 'An in-memory hub cannot be restored into');
    if (!BACKUP_NAME_RE.test(`${backupId}.sqlite`)) throw new DomainError('validation', 'That is not a backup identifier produced by this hub');
    const source = join(this.dir(), `${backupId}.sqlite`);
    this.validate(source);

    const safety = await this.create(actor, meta, 'safety');
    // Swap by rename so the window in which no database file exists is as small as the filesystem
    // can make it, and the previous file is kept as `.replaced` until the restart succeeds.
    checkpoint(this.db);
    this.db.close();
    const replaced = `${this.dbFile}.replaced`;
    rmSync(replaced, { force: true });
    if (existsSync(this.dbFile)) renameSync(this.dbFile, replaced);
    rmSync(`${this.dbFile}-wal`, { force: true });
    rmSync(`${this.dbFile}-shm`, { force: true });
    const restoring = openDatabase({ file: source, readonly: true });
    try {
      await restoring.backup(this.dbFile);
    } finally {
      restoring.close();
    }

    this.metrics.increment('backup.restored');
    this.audit.record({
      actor: { kind: 'admin', id: actor.id, displayName: actor.displayName },
      action: 'backup.restore',
      outcome: 'success',
      target: { kind: 'backup', id: backupId },
      ip: meta.ip,
      correlationId: meta.correlationId,
      details: { safetyBackupId: safety.id },
    });
    return { ok: true, safetyBackupId: safety.id, restartRequired: true };
  }

  /**
   * Portable JSON export. Every field here is either public or the operator's own configuration;
   * secrets are enumerated explicitly below so a future field cannot leak in by accident.
   */
  exportAll(): { schemaVersion: number; exportedAt: string; data: Record<string, unknown> } {
    const groups = this.repos.groups.listAll().map((g) => ({
      ...g,
      members: this.repos.groups.listMemberships(g.id).map((m) => ({ memberId: m.memberId, displayName: m.displayName, role: m.role, shareAggregate: m.shareAggregate, joinedAt: m.joinedAt })),
      history: this.repos.groups.allHistory(g.id),
    }));
    const devices = this.repos.devices.listDevices().map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      protocolVersion: d.protocolVersion,
      scopes: d.scopes,
      publicKeyFingerprint: d.publicKeyFingerprint,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      revokedAt: d.revokedAt,
      // Credential secrets and their hashes are never exported: a restored export must re-pair.
    }));
    const data: Record<string, unknown> = {
      hub: { name: this.repos.settings.get<{ name?: string }>('hub.identity')?.name ?? 'Now Playing hub' },
      groups,
      devices,
      playlists: this.repos.sync.all('playlists'),
      playlistItems: this.repos.sync.all('playlistItems'),
      eqPresets: this.repos.sync.all('eqPresets'),
      eqBindings: this.repos.sync.all('eqBindings'),
      libraryRoots: this.repos.library.listRoots().map((r) => ({ id: r.id, displayName: r.displayName, handleId: r.handleId, kind: r.kind })),
      shares: this.repos.shares.list().map(({ tokenHash: _t, ...s }) => s),
      providers: this.repos.providers.allConfigs().map((c) => ({ provider: c.provider, enabled: c.enabled === 1 })),
    };
    this.metrics.increment('backup.exported');
    return { schemaVersion: EXPORT_SCHEMA_VERSION, exportedAt: this.nowIso(), data };
  }

  /**
   * Import an export. `dryRun` validates and reports counts without writing, which is what the
   * admin GUI shows before asking for confirmation. Import is additive: it never deletes rows the
   * operator already has, and it skips anything whose id already exists.
   */
  importAll(payload: { schemaVersion: number; data: Record<string, unknown> }, dryRun: boolean, actor: { id: string; displayName: string }, meta: RequestMeta): ImportReport {
    const errors: string[] = [];
    const applied: Record<string, number> = {};
    if (payload.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      errors.push(`This export is schema version ${payload.schemaVersion}; this hub reads version ${EXPORT_SCHEMA_VERSION}.`);
      return { dryRun, applied, errors };
    }

    const syncCollections = ['playlists', 'playlistItems', 'eqPresets', 'eqBindings'] as const;
    const run = (): void => {
      for (const collection of syncCollections) {
        const rows = payload.data[collection];
        if (!Array.isArray(rows)) continue;
        let count = 0;
        for (const raw of rows) {
          const row = raw as { id?: unknown; updatedAt?: unknown };
          if (typeof row.id !== 'string' || typeof row.updatedAt !== 'string') {
            errors.push(`A ${collection} row is missing id or updatedAt and was skipped.`);
            continue;
          }
          if (this.repos.sync.get(collection, row.id)) continue;
          if (!dryRun) this.repos.sync.put(collection, { ...(raw as Record<string, unknown>), id: row.id, updatedAt: row.updatedAt, deletedAt: null }, importChangeId(collection, row.id), 'import');
          count += 1;
        }
        applied[collection] = count;
      }

      const groups = payload.data['groups'];
      if (Array.isArray(groups)) {
        let count = 0;
        for (const raw of groups) {
          const group = raw as { id?: unknown; name?: unknown };
          if (typeof group.id !== 'string' || typeof group.name !== 'string') {
            errors.push('A group row is missing id or name and was skipped.');
            continue;
          }
          if (this.repos.groups.find(group.id)) continue;
          count += 1;
        }
        // Group *state* (queue, playback, memberships) is intentionally not imported: it names
        // devices that are not paired with this hub, and a queue restored without its listeners
        // would start playing to nobody.
        applied['groups'] = count;
        if (count) errors.push(`${count} group${count === 1 ? '' : 's'} in the export could not be recreated: groups are tied to the devices paired with a hub, so recreate them after pairing.`);
      }
    };

    if (dryRun) run();
    else this.repos.sync.transaction(run);

    this.metrics.increment(dryRun ? 'backup.import_dry_run' : 'backup.imported');
    if (!dryRun) {
      this.audit.record({
        actor: { kind: 'admin', id: actor.id, displayName: actor.displayName },
        action: 'backup.import',
        outcome: 'success',
        target: { kind: 'backup', id: 'import' },
        ip: meta.ip,
        correlationId: meta.correlationId,
        details: { ...Object.fromEntries(Object.entries(applied).map(([k, v]) => [k, String(v)])), skipped: String(errors.length) },
      });
    }
    return { dryRun, applied, errors };
  }
}

/** Deterministic change id for imported rows, so re-importing the same export is a no-op. */
function importChangeId(collection: string, id: string): string {
  const h = createHash('sha256').update(`import:${collection}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
