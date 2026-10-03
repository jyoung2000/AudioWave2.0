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
import { accessSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import { BackupSettings, type BackupSettingsView } from '@now-playing/contracts';
import { DomainError } from '@now-playing/domain';
import { diskUsage } from '../disk-usage.js';
import { nextScheduledRun } from './schedule.js';
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
/**
 * Keep this many pre-restore (`-safety`) backups. Scheduled (`-auto`) backups follow the operator's
 * Keep setting; the operator's own backups (no suffix) are never pruned.
 */
const KEEP_SAFETY_BACKUPS = 10;
const BACKUP_NAME_RE = /^backup-(\d{8}T\d{6}Z)(-safety|-auto)?\.sqlite$/;
const SETTINGS_KEY = 'backup.settings';
/** When the schedule was last saved or last ran: the next run is the first slot after it. */
const ANCHOR_KEY = 'backup.schedule.anchor';
const LAST_RUN_KEY = 'backup.schedule.lastRunAt';
/** First segments a backup folder may not use: the installation key lives in `keys/`. */
const RESERVED_FOLDERS = new Set(['keys']);

/** What a hub has before anyone changes it: what it always did — every night, the last 10 kept. */
export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  location: 'backups',
  include: { credentials: true, activity: true, caches: true },
  schedule: { frequency: 'daily', time: '03:00', weekday: 0 },
  keep: 10,
};

/**
 * What each optional part removes from the archive (never from the live database). Columns are
 * cleared rather than rows deleted where other rows depend on them, so a restored hub keeps its
 * accounts and only has to sign in to them again.
 */
const STRIP: Record<keyof BackupSettings['include'], string[]> = {
  credentials: [
    'UPDATE provider_app_configs SET client_secret_sealed = NULL, api_key_sealed = NULL',
    'UPDATE provider_accounts SET access_token_sealed = NULL, refresh_token_sealed = NULL',
    'UPDATE platform_connections SET access_token_sealed = NULL, refresh_token_sealed = NULL',
    'DELETE FROM oauth_states',
    "DELETE FROM settings WHERE key = 'discord.token'",
  ],
  activity: ['DELETE FROM audit_events', 'DELETE FROM metrics_samples'],
  caches: ['DELETE FROM metadata_cache', 'DELETE FROM discovery_cache'],
};

export type BackupKind = 'manual' | 'auto' | 'safety';

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
    private readonly log: Logger,
    /**
     * How the process ends after a restore. Injected so a test can observe the call instead of
     * taking the suite down with it.
     */
    private readonly exit: (code: number) => void = (code: number) => process.exit(code),
  ) {
    mkdirSync(this.dir(), { recursive: true });
  }

  private dir(): string {
    return this.config.backupDir ?? join(this.config.dataDir, ...this.settings().location.split('/'));
  }

  /* ------------------------------------------------------------ settings */

  /** The stored settings, with anything missing or unreadable taken from the defaults. */
  settings(): BackupSettings {
    const stored = this.repos.settings.get<Partial<BackupSettings>>(SETTINGS_KEY) ?? {};
    const merged = BackupSettings.safeParse({
      ...DEFAULT_BACKUP_SETTINGS,
      ...stored,
      include: { ...DEFAULT_BACKUP_SETTINGS.include, ...(stored.include ?? {}) },
      schedule: { ...DEFAULT_BACKUP_SETTINGS.schedule, ...(stored.schedule ?? {}) },
    });
    return merged.success ? merged.data : DEFAULT_BACKUP_SETTINGS;
  }

  settingsView(): BackupSettingsView {
    const settings = this.settings();
    const anchor = this.anchorMs();
    const next = nextScheduledRun(settings.schedule, anchor ?? this.clock.now());
    return {
      ...settings,
      path: this.dir(),
      dataDir: this.config.dataDir,
      locationFixed: this.config.backupDir !== null,
      nextRunAt: next === null ? null : new Date(next).toISOString(),
      lastRunAt: this.repos.settings.get<string>(LAST_RUN_KEY) ?? null,
    };
  }

  /**
   * Change where backups go, what they hold, when they run and how many are kept. The folder must be
   * inside the data volume — typed relative to it ("backups") or as the container sees it
   * ("/data/backups") — and is created and checked for writing before it is stored, so a typo fails
   * here rather than at 03:00.
   */
  updateSettings(patch: { [K in keyof BackupSettings]?: BackupSettings[K] | undefined }, actor: { id: string; displayName: string }, meta: RequestMeta): BackupSettingsView {
    const current = this.settings();
    const next: BackupSettings = {
      location: current.location,
      keep: patch.keep ?? current.keep,
      include: { ...current.include, ...(patch.include ?? {}) },
      schedule: { ...current.schedule, ...(patch.schedule ?? {}) },
    };
    if (patch.location !== undefined) {
      const location = this.normaliseLocation(patch.location);
      if (this.config.backupDir !== null && location !== current.location) {
        throw new DomainError('validation', 'The backup folder is set by NP_BACKUP_DIR in the container’s environment. Change it there.');
      }
      next.location = location;
    }
    const scheduleChanged = JSON.stringify(next.schedule) !== JSON.stringify(current.schedule);
    const now = this.nowIso();
    this.repos.settings.transaction(() => {
      this.repos.settings.set(SETTINGS_KEY, next, now);
      // A new schedule counts from now: changing "weekly" to "daily" at 02:59 does not mean a
      // backup at 03:00 for every day that was missed.
      if (scheduleChanged) this.repos.settings.set(ANCHOR_KEY, now, now);
    });
    this.prune();
    this.audit.record({
      actor: { kind: 'admin', id: actor.id, displayName: actor.displayName },
      action: 'backup.settings',
      outcome: 'success',
      target: { kind: 'backup', id: 'settings' },
      ip: meta.ip,
      correlationId: meta.correlationId,
      details: { location: next.location, frequency: next.schedule.frequency, keep: String(next.keep), credentials: String(next.include.credentials), activity: String(next.include.activity), caches: String(next.include.caches) },
    });
    return this.settingsView();
  }

  /** A folder inside the data volume, as the stored relative form, or a validation error that says why not. */
  private normaliseLocation(typed: string): string {
    const dataDir = resolve(this.config.dataDir);
    const shown = dataDir.replaceAll('\\', '/').replace(/\/+$/, '');
    const refuse = (): never => {
      throw new DomainError('validation', `Use a folder inside the data volume, such as ${shown}/backups.`);
    };
    let text = typed.trim().replaceAll('\\', '/');
    if (!text) refuse();
    if (text === shown) refuse();
    if (text.startsWith(`${shown}/`)) text = text.slice(shown.length + 1);
    else if (isAbsolute(text) || /^[a-z]:/i.test(text)) refuse();
    const segments = text.split('/').filter(Boolean);
    if (!segments.length || segments.some((s) => s === '.' || s === '..' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(s))) refuse();
    if (RESERVED_FOLDERS.has(segments[0]!.toLowerCase())) {
      throw new DomainError('validation', `${shown}/${segments[0]} holds the installation key. Choose another folder.`);
    }
    const location = segments.join('/');
    const absolute = resolve(dataDir, ...segments);
    const inside = (root: string, path: string): boolean => {
      const rel = relative(root, path);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!inside(dataDir, absolute)) refuse();
    try {
      mkdirSync(absolute, { recursive: true });
      // A link inside the volume that points out of it is still outside it.
      if (!inside(realpathSync(dataDir), realpathSync(absolute))) refuse();
      accessSync(absolute, fsConstants.W_OK);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError('validation', `The hub can’t write to ${shown}/${location}. Check the folder’s permissions.`);
    }
    return location;
  }

  private anchorMs(): number | null {
    const iso = this.repos.settings.get<string>(ANCHOR_KEY);
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Called every minute by the scheduler: take a scheduled backup when its slot has come. A hub that
   * was off at the slot takes it when it next starts. Returns the backup taken, if any.
   */
  async runScheduled(): Promise<BackupEntry | null> {
    const settings = this.settings();
    if (settings.schedule.frequency === 'off') return null;
    const now = this.clock.now();
    const anchor = this.anchorMs();
    if (anchor === null) {
      // First run of a fresh hub: count from now rather than from the epoch.
      this.repos.settings.set(ANCHOR_KEY, new Date(now).toISOString(), new Date(now).toISOString());
      return null;
    }
    const due = nextScheduledRun(settings.schedule, anchor);
    if (due === null || now < due) return null;
    // Move the anchor first: a backup that fails waits for its next slot instead of retrying every minute.
    this.repos.settings.set(ANCHOR_KEY, new Date(now).toISOString(), new Date(now).toISOString());
    const entry = await this.create(null, null, 'auto');
    this.repos.settings.set(LAST_RUN_KEY, entry.createdAt, entry.createdAt);
    return entry;
  }

  /**
   * The file for one archive this hub lists, for downloading. Only names the hub itself writes are
   * accepted, and only from the folder it lists, so no request can reach any other file.
   */
  archive(backupId: string): { path: string; sizeBytes: number; fileName: string } {
    if (!BACKUP_NAME_RE.test(`${backupId}.sqlite`)) throw new DomainError('not-found', 'No such backup');
    const entry = this.list().find((b) => b.id === backupId);
    if (!entry) throw new DomainError('not-found', 'No such backup');
    return { path: join(this.dir(), `${entry.id}.sqlite`), sizeBytes: entry.sizeBytes, fileName: `${entry.id}.sqlite` };
  }

  private relativePathOf(fileName: string): string {
    const rel = relative(resolve(this.config.dataDir), join(this.dir(), fileName)).replaceAll('\\', '/');
    return rel.startsWith('..') || isAbsolute(rel) ? fileName : rel;
  }

  /**
   * Room at the backup location and the size of the newest archive. A missing or unreadable
   * directory is reported as unknown (nulls), never as an error and never as zero.
   *
   * `forDevice` hides a location outside the data volume: a paired player has no business learning
   * the operator's host paths, only that the backups go to a host folder.
   */
  async space(forDevice: boolean): Promise<{ path: string; freeBytes: number | null; totalBytes: number | null; lastArchiveBytes: number | null; keep: number | null }> {
    const dir = this.dir();
    const inside = dir === this.config.dataDir || dir.startsWith(this.config.dataDir + sep);
    const volume = await diskUsage(dir);
    let lastArchiveBytes: number | null;
    try {
      lastArchiveBytes = this.list()[0]?.sizeBytes ?? null;
    } catch {
      lastArchiveBytes = null;
    }
    return { path: forDevice && !inside ? 'host folder' : dir, freeBytes: volume.freeBytes, totalBytes: volume.totalBytes, lastArchiveBytes, keep: this.settings().keep || null };
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private stamp(): string {
    return this.nowIso().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  }

  async create(actor: { id: string; displayName: string } | null, meta: RequestMeta | null, kind: BackupKind = 'manual'): Promise<BackupEntry> {
    if (this.dbFile === ':memory:') throw new DomainError('unsupported', 'This hub is running against an in-memory database, so there is nothing to back up');
    const id = `backup-${this.stamp()}${kind === 'manual' ? '' : `-${kind}`}`;
    mkdirSync(this.dir(), { recursive: true });
    const file = join(this.dir(), `${id}.sqlite`);
    // Checkpoint first so the backup contains everything the WAL is holding.
    checkpoint(this.db);
    await this.db.backup(file);
    // A safety backup is taken before a restore and must hold everything; the others hold what the
    // operator chose.
    const left = kind === 'safety' ? [] : this.leftOut();
    if (left.length) this.strip(file, left);
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
        details: { sizeBytes: String(sizeBytes), leftOut: left.join(',') || 'nothing' },
      });
    }
    this.prune();
    return { id, createdAt: this.nowIso(), sizeBytes, relativePath: this.relativePathOf(`${id}.sqlite`) };
  }

  /** The optional parts the settings leave out of a backup. */
  private leftOut(): Array<keyof BackupSettings['include']> {
    const include = this.settings().include;
    return (Object.keys(STRIP) as Array<keyof BackupSettings['include']>).filter((part) => !include[part]);
  }

  /** Remove the parts left out from a freshly written archive, then compact it so they are gone from the file too. */
  private strip(file: string, parts: ReadonlyArray<keyof BackupSettings['include']>): void {
    const archive = openDatabase({ file });
    try {
      archive.transaction(() => {
        for (const part of parts) for (const sql of STRIP[part]) archive.exec(sql);
      })();
      archive.exec('VACUUM');
      checkpoint(archive);
    } catch (err) {
      archive.close();
      rmSync(file, { force: true });
      for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
      throw new DomainError('unavailable', `The backup could not leave out what was asked (${err instanceof Error ? err.message : String(err)}), so it was not kept.`);
    }
    archive.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  }

  list(): BackupEntry[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && BACKUP_NAME_RE.test(e.name))
      .map((e) => {
        const id = e.name.replace(/\.sqlite$/, '');
        const s = statSync(join(this.dir(), e.name));
        return { id, createdAt: new Date(s.mtimeMs).toISOString(), sizeBytes: s.size, relativePath: this.relativePathOf(e.name) };
      })
      // Newest first, by the stamp in the name (mtime resolution varies by filesystem), then mtime.
      .sort((a, b) => {
        const sa = BACKUP_NAME_RE.exec(`${a.id}.sqlite`)?.[1] ?? '';
        const sb = BACKUP_NAME_RE.exec(`${b.id}.sqlite`)?.[1] ?? '';
        if (sa !== sb) return sa < sb ? 1 : -1;
        return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      });
  }

  lastBackupAt(): string | null {
    return this.list()[0]?.createdAt ?? null;
  }

  /**
   * Prune scheduled backups to the Keep setting (0 keeps them all) and safety backups to ten, oldest
   * first; manual backups are the operator's to delete.
   */
  private prune(): void {
    const all = this.list();
    const keep = this.settings().keep;
    const limits: Array<[string, number]> = [['-safety', KEEP_SAFETY_BACKUPS]];
    if (keep > 0) limits.push(['-auto', keep]);
    for (const [suffix, limit] of limits) {
      for (const stale of all.filter((b) => b.id.endsWith(suffix)).slice(limit)) rmSync(join(this.dir(), `${stale.id}.sqlite`), { force: true });
    }
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

    // Stage the candidate next to the live file and verify the copy while the hub still runs, so a
    // failed copy never touches the live database.
    const staged = `${this.dbFile}.restoring`;
    removeDbFiles(staged);
    try {
      const restoring = openDatabase({ file: source, readonly: true });
      try {
        await restoring.backup(staged);
      } finally {
        restoring.close();
      }
      this.validate(staged);
      rmSync(`${staged}-wal`, { force: true });
      rmSync(`${staged}-shm`, { force: true });
    } catch (err) {
      removeDbFiles(staged);
      this.metrics.increment('backup.restore_failed');
      if (err instanceof DomainError) throw err;
      throw new DomainError('unavailable', `The backup could not be copied into place (${err instanceof Error ? err.message : String(err)}); the current database was not changed.`);
    }

    // Record while the database is still open: after the swap this handle is closed for good.
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

    // Swap by rename so the window in which no database file exists is as small as the filesystem
    // can make it, and the previous file is kept as `.replaced` until the restart succeeds.
    checkpoint(this.db);
    this.db.close();
    const replaced = `${this.dbFile}.replaced`;
    rmSync(replaced, { force: true });
    try {
      if (existsSync(this.dbFile)) renameSync(this.dbFile, replaced);
      rmSync(`${this.dbFile}-wal`, { force: true });
      rmSync(`${this.dbFile}-shm`, { force: true });
      renameSync(staged, this.dbFile);
    } catch (err) {
      // Roll back: put the previous file back, or failing that the safety copy just taken.
      try {
        if (!existsSync(this.dbFile)) {
          if (existsSync(replaced)) renameSync(replaced, this.dbFile);
          else copyFileSync(join(this.dir(), `${safety.id}.sqlite`), this.dbFile);
        }
      } finally {
        removeDbFiles(staged);
      }
      throw new DomainError('unavailable', `The restored database could not be swapped in (${err instanceof Error ? err.message : String(err)}); the previous database was put back. Restart the hub.`);
    }
    /*
     * The database handle is now closed for good, and nothing else in the process knows that. The
     * hub would keep listening and keep answering `/healthz` while every request that touches the
     * database failed — a live-but-dead container that an orchestrator has no reason to replace.
     *
     * So end the process deliberately. `restart: unless-stopped` in compose.yaml (and any
     * equivalent supervisor) brings it straight back up against the restored file. `setImmediate`
     * so this response is written first: the operator sees the result of the restore they asked
     * for, rather than a dropped connection.
     */
    this.log.warn({ module: 'backup', backup: backupId, safetyBackupId: safety.id }, 'database restored; exiting so the supervisor restarts the hub against it');
    setImmediate(() => this.exit(0));
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
      hub: { name: this.repos.settings.get<{ name?: string }>('hub.identity')?.name ?? 'Airwave hub' },
      groups,
      devices,
      playlists: this.repos.sync.all('playlists'),
      playlistItems: this.repos.sync.all('playlistItems'),
      eqPresets: this.repos.sync.all('eqPresets'),
      eqBindings: this.repos.sync.all('eqBindings'),
      libraryRoots: this.repos.library.listRoots().map((r) => ({ id: r.id, displayName: r.displayName, handleId: r.handleId, kind: r.kind })),
      shares: this.repos.shares.list().map(({ tokenHash: _t, ...s }) => s),
      // Profiles are visible to every paired device already, so nothing here is secret. The SQLite
      // backup carries the same rows; this is for moving to a new hub.
      profiles: (this.db.prepare('SELECT id, display_name AS displayName, profile_name_key IS NOT NULL AS claimed FROM hub_users WHERE deleted_at IS NULL ORDER BY created_at').all() as Array<{ id: string; displayName: string; claimed: number }>).map((u) => ({
        id: u.id,
        displayName: u.displayName,
        claimed: u.claimed === 1,
        avatarWebpBase64: (this.db.prepare('SELECT bytes FROM profile_avatars WHERE user_id = ?').get(u.id) as { bytes: Buffer } | undefined)?.bytes.toString('base64') ?? null,
        playlists: this.db.prepare('SELECT playlist_id AS id, name, tracks, csv, updated_at AS updatedAt FROM profile_playlists WHERE user_id = ? ORDER BY playlist_id').all(u.id),
      })),
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

function removeDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${file}${suffix}`, { force: true });
}

/** Deterministic change id for imported rows, so re-importing the same export is a no-op. */
function importChangeId(collection: string, id: string): string {
  const h = createHash('sha256').update(`import:${collection}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
