/**
 * Backups, for real: an archive written into the folder the person chose, a list of the archives
 * that are there, the count kept, and a schedule that runs while the app is open.
 *
 * An archive is a dated folder, not a single file: `data.json` holds the playlists, presets and
 * settings (the same shape an export from any companion has, so either restores from it), and the
 * included library folders are copied beside it under their own names. Copying a library is the
 * only backup of a library there is; a "backup" that left the music out would be a surprise at the
 * worst moment. Whether the music is included is a checkbox, and the estimate says what that costs.
 *
 * The folder figures are `local-helper/src/measure.ts`'s, the same code behind the helper's
 * `/helper/v1/backup/estimate`, on the same folders. That is what makes the player's Backup pane and
 * this window agree: they are not two measurements that happen to match, they are one.
 *
 * Nothing here touches Electron, so the integration tests drive it directly against a temp folder.
 */
import { copyFile, link, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EqPreset, Playlist } from '@now-playing/contracts';
import { BACKUP_PARTS, createEstimator, measureFolder, type BackupPart } from '@now-playing/local-helper/measure';
import { BackupSettings, BackupSummary, type BackupArchive, type BackupEstimate, type BackupProgress, type BackupSettingsPatch, type FolderKind } from '../shared/ipc.js';
import type { CompanionStore } from './store.js';

const SETTINGS_KEY = 'backup';
const ARCHIVE_PREFIX = 'now-playing-companion-';
/** A day and a week, for the schedule; a run that is late by a few minutes is still on time. */
const DAY_MS = 24 * 60 * 60_000;
const SCHEDULE_MS = { manual: Infinity, daily: DAY_MS, weekly: 7 * DAY_MS } as const;

/** What `data.json` holds. Version 1 is the export format the companion has always written. */
export const BackupFile = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.iso.datetime({ offset: true }).optional(),
  playlists: z.array(Playlist).max(100_000).default([]),
  presets: z.array(EqPreset).max(10_000).default([]),
  counts: BackupSummary.shape.contents.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type BackupFile = z.infer<typeof BackupFile>;

const Manifest = z.object({
  schemaVersion: z.literal(2),
  createdAt: z.iso.datetime({ offset: true }),
  parts: z.array(z.enum(['music', 'tv', 'movies', 'playlists', 'presets', 'settings'])),
  sizeBytes: z.number().int().nonnegative(),
  contents: BackupSummary.shape.contents,
});

export interface BackupManagerOptions {
  store: CompanionStore;
  /** Settings the archive carries when "these settings" is included, and restores from. */
  readSettings: () => Record<string, unknown>;
  writeSettings: (settings: Record<string, unknown>) => void;
  onProgress: (progress: BackupProgress) => void;
  onNotice: (kind: 'info' | 'warning' | 'error', message: string) => void;
  now?: () => number;
  /** How long one estimate may take. Default 20 s, as the helper's route. */
  budgetMs?: number;
}

type Estimator = ReturnType<typeof createEstimator>;

export class BackupManager {
  private readonly now: () => number;
  private estimator: Estimator | null = null;
  private estimatorKey = '';
  private running: Promise<{ backup: BackupSummary | null; reason: string | null }> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: BackupManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  /* --------------------------------------------------------------- settings */

  settings(): BackupSettings {
    const parsed = BackupSettings.safeParse(this.options.store.get<unknown>(SETTINGS_KEY, {}) ?? {});
    return parsed.success ? parsed.data : BackupSettings.parse({});
  }

  private save(next: BackupSettings): BackupSettings {
    this.options.store.set(SETTINGS_KEY, next, new Date(this.now()).toISOString());
    return next;
  }

  update(patch: BackupSettingsPatch): BackupSettings {
    const current = this.settings();
    const include = { ...current.include };
    for (const key of Object.keys(include) as Array<keyof typeof include>) {
      const value = patch.include?.[key];
      if (value !== undefined) include[key] = value;
    }
    return this.save({
      ...current,
      include,
      schedule: patch.schedule ?? current.schedule,
      keep: patch.keep ?? current.keep,
    });
  }

  setDir(dir: string | null): BackupSettings {
    return this.save({ ...this.settings(), dir });
  }

  /** The folders a part is made of: what the helper is started with, so both measure the same thing. */
  folders(): Partial<Record<BackupPart, string[]>> {
    const out: Partial<Record<BackupPart, string[]>> = {};
    for (const part of BACKUP_PARTS) {
      const paths = this.options.store.folderPaths(part as FolderKind);
      if (paths.length) out[part] = paths;
    }
    return out;
  }

  /* --------------------------------------------------------------- estimate */

  private estimatorFor(dir: string | null): Estimator {
    const folders = this.folders();
    const key = JSON.stringify([folders, dir]);
    if (!this.estimator || key !== this.estimatorKey) {
      this.estimator = createEstimator({ folders, backupDir: dir, now: this.now, ...(this.options.budgetMs ? { budgetMs: this.options.budgetMs } : {}) });
      this.estimatorKey = key;
    }
    return this.estimator;
  }

  private dataPayload(include: BackupSettings['include']): { text: string; parts: BackupArchive['parts'] } {
    const store = this.options.store;
    const parts: BackupArchive['parts'] = [];
    const payload: BackupFile & { folders: Array<{ displayName: string; kind: string; trackCount: number }> } = {
      schemaVersion: 1,
      exportedAt: new Date(this.now()).toISOString(),
      // Folders are recorded by name only: an absolute path is this machine's business.
      folders: store.listFolders(() => true).map((f) => ({ displayName: f.displayName, kind: f.kind, trackCount: f.trackCount })),
      playlists: include.playlists ? store.listPlaylists() : [],
      presets: include.presets ? store.listPresets() : [],
      counts: store.counts(),
    };
    if (include.playlists) parts.push('playlists');
    if (include.presets) parts.push('presets');
    if (include.settings) {
      payload.settings = this.options.readSettings();
      parts.push('settings');
    }
    return { text: JSON.stringify(payload, null, 2), parts };
  }

  async estimate(): Promise<BackupEstimate> {
    const settings = this.settings();
    const wanted = BACKUP_PARTS.filter((part: BackupPart) => settings.include[part]);
    const measured = await this.estimatorFor(settings.dir)(wanted);
    const folders = this.folders();
    const dataBytes = Buffer.byteLength(this.dataPayload(settings.include).text);
    let expected = dataBytes;
    let complete = true;
    const parts: BackupEstimate['parts'] = {};
    for (const part of wanted) {
      const m = measured.parts[part];
      if (m) {
        parts[part] = m;
        expected += m.bytes;
      } else if (folders[part]?.length) {
        // A part that is asked for but not measured makes the total unknown, never smaller.
        complete = false;
      }
    }
    const destination = measured.destination;
    let blocked: string | null = null;
    if (!settings.dir) blocked = 'Choose where backups go first.';
    else if (!complete) blocked = 'A folder could not be measured in time; try again in a moment.';
    else if (destination?.freeBytes !== null && destination?.freeBytes !== undefined && destination.freeBytes < expected) blocked = `This backup needs ${formatBytes(expected)} and ${basename(settings.dir) || settings.dir} has ${formatBytes(destination.freeBytes)} free.`;
    return { parts, dataBytes, expectedBytes: expected, complete, destination, blocked };
  }

  /* ---------------------------------------------------------------- archives */

  async list(): Promise<BackupArchive[]> {
    const dir = this.settings().dir;
    if (!dir) return [];
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name.startsWith(ARCHIVE_PREFIX)).map((e) => e.name);
    } catch {
      return [];
    }
    const items: BackupArchive[] = [];
    for (const name of names) {
      const path = join(dir, name);
      try {
        const manifest = Manifest.parse(JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')));
        items.push({ id: name, path, createdAt: manifest.createdAt, sizeBytes: manifest.sizeBytes, parts: manifest.parts, contents: manifest.contents, restorable: true });
      } catch {
        // A folder with the name but no readable manifest: shown, so it can be removed, not restored.
        const createdAt = new Date((await stat(path).catch(() => null))?.mtimeMs ?? this.now()).toISOString();
        items.push({ id: name, path, createdAt, sizeBytes: 0, parts: [], contents: { tracks: 0, playlists: 0, presets: 0, events: 0 }, restorable: false });
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async remove(id: string): Promise<{ ok: boolean; reason: string | null }> {
    const dir = this.settings().dir;
    if (!dir || !id.startsWith(ARCHIVE_PREFIX) || id.includes('/') || id.includes('\\') || id.includes('..')) return { ok: false, reason: 'That is not one of the backups here.' };
    try {
      await rm(join(dir, id), { recursive: true, force: true });
      return { ok: true, reason: null };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Drops the oldest archives past the kept count. Called after every backup and every setting change. */
  async prune(): Promise<number> {
    const { keep } = this.settings();
    if (!keep) return 0;
    const items = (await this.list()).filter((a) => a.restorable);
    let removed = 0;
    for (const old of items.slice(keep)) {
      if ((await this.remove(old.id)).ok) removed += 1;
    }
    return removed;
  }

  create(): Promise<{ backup: BackupSummary | null; reason: string | null }> {
    if (this.running) return Promise.resolve({ backup: null, reason: 'A backup is already running.' });
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<{ backup: BackupSummary | null; reason: string | null }> {
    const settings = this.settings();
    const progress = (p: Partial<BackupProgress> & { phase: BackupProgress['phase'] }) => this.options.onProgress({ bytesDone: 0, bytesTotal: 0, currentName: null, error: null, ...p });
    if (!settings.dir) return { backup: null, reason: 'Choose where backups go first.' };
    progress({ phase: 'measuring' });
    const estimate = await this.estimate();
    if (estimate.blocked) {
      this.save({ ...this.settings(), lastRunError: estimate.blocked });
      progress({ phase: 'failed', error: estimate.blocked });
      return { backup: null, reason: estimate.blocked };
    }
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const id = `${ARCHIVE_PREFIX}${stamp}`;
    const path = join(settings.dir, id);
    const { text, parts } = this.dataPayload(settings.include);
    let written = 0;
    const total = estimate.expectedBytes;
    try {
      await mkdir(path, { recursive: true });
      progress({ phase: 'writing', bytesTotal: total });
      await writeFile(join(path, 'data.json'), text, 'utf8');
      written += Buffer.byteLength(text);
      const folders = this.folders();
      for (const part of BACKUP_PARTS) {
        if (!settings.include[part] || !folders[part]?.length) continue;
        parts.push(part);
        for (const source of folders[part]!) {
          const target = join(path, part, uniqueName(basename(source) || part, folders[part]!, source));
          written = await copyTree(source, target, written, (done, name) => progress({ phase: 'copying', bytesDone: done, bytesTotal: total, currentName: name }));
        }
      }
      const contents = this.options.store.counts();
      const createdAt = new Date(this.now()).toISOString();
      await writeFile(join(path, 'manifest.json'), JSON.stringify({ schemaVersion: 2, createdAt, parts, sizeBytes: written, contents }, null, 2), 'utf8');
      this.save({ ...this.settings(), lastRunAt: createdAt, lastRunError: null });
      progress({ phase: 'pruning', bytesDone: written, bytesTotal: total });
      await this.prune();
      progress({ phase: 'done', bytesDone: written, bytesTotal: written });
      return { backup: { path, createdAt, sizeBytes: written, contents }, reason: null };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A half-written archive is worse than none: it looks restorable.
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      this.save({ ...this.settings(), lastRunError: reason });
      progress({ phase: 'failed', bytesDone: written, bytesTotal: total, error: reason });
      return { backup: null, reason };
    }
  }

  /* ---------------------------------------------------------------- restore */

  async restoreArchive(id: string): Promise<{ restored: boolean; reason: string | null; summary: BackupSummary | null }> {
    const dir = this.settings().dir;
    if (!dir || !id.startsWith(ARCHIVE_PREFIX) || id.includes('/') || id.includes('\\') || id.includes('..')) return { restored: false, reason: 'That is not one of the backups here.', summary: null };
    const path = join(dir, id);
    let text: string;
    try {
      text = await readFile(join(path, 'data.json'), 'utf8');
    } catch {
      return { restored: false, reason: 'That backup has no data.json, so there is nothing to restore from it.', summary: null };
    }
    const result = this.applyFile(text, path);
    if (result.restored) this.options.onNotice('info', 'Playlists, presets and settings were restored. Copied music stays in the backup folder; move it back yourself, then add the folder again.');
    return result;
  }

  /**
   * Restore from the JSON an export or an archive holds. Everything is checked before anything is
   * written: a backup is restored whole or not at all.
   */
  applyFile(text: string, path: string): { restored: boolean; reason: string | null; summary: BackupSummary | null } {
    const store = this.options.store;
    let raw: { schemaVersion?: unknown } | null;
    try {
      raw = JSON.parse(text) as { schemaVersion?: unknown } | null;
    } catch (err) {
      return { restored: false, reason: `That file could not be read as a backup: ${err instanceof Error ? err.message : String(err)}`, summary: null };
    }
    if (raw?.schemaVersion !== 1) return { restored: false, reason: `That backup is version ${String(raw?.schemaVersion ?? 'unknown')}; this app reads version 1.`, summary: null };
    const parsed = BackupFile.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'file'}: ${i.message}`);
      return { restored: false, reason: `That backup is damaged or incomplete, so nothing was restored (${issues.join('; ')}).`, summary: null };
    }
    const payload = parsed.data;
    const now = new Date(this.now()).toISOString();
    store.transaction(() => {
      // A restored record is stamped now so it syncs as a change, unless this computer already has
      // the same or a newer version of it.
      for (const playlist of payload.playlists) {
        const local = store.syncedState('playlists', playlist.id);
        if (local && !local.deletedAt && Date.parse(local.updatedAt) >= Date.parse(playlist.updatedAt)) continue;
        store.putSynced('playlists', playlist.id, { ...playlist, updatedAt: now, deletedAt: null }, now, null);
      }
      for (const preset of payload.presets) {
        const local = store.syncedState('eq_presets', preset.id);
        if (local && !local.deletedAt && Date.parse(local.updatedAt) >= Date.parse(preset.updatedAt)) continue;
        store.putSynced('eq_presets', preset.id, { ...preset, updatedAt: now, deletedAt: null }, now, null);
      }
    });
    if (payload.settings) this.options.writeSettings(payload.settings);
    return { restored: true, reason: null, summary: { path, createdAt: payload.exportedAt ?? now, sizeBytes: Buffer.byteLength(text), contents: payload.counts ?? store.counts() } };
  }

  /* --------------------------------------------------------------- schedule */

  /** True when the schedule says a backup is due now. */
  due(): boolean {
    const { schedule, lastRunAt, dir } = this.settings();
    if (!dir || schedule === 'manual') return false;
    const last = lastRunAt ? Date.parse(lastRunAt) : 0;
    return this.now() - last >= SCHEDULE_MS[schedule];
  }

  /** Runs a backup if one is due. Returns what happened, for the caller's log. */
  async tick(): Promise<{ ran: boolean; reason: string | null }> {
    if (!this.due() || this.running) return { ran: false, reason: null };
    const result = await this.create();
    if (result.reason) this.options.onNotice('warning', `The scheduled backup did not run: ${result.reason}`);
    return { ran: result.backup !== null, reason: result.reason };
  }

  /** Checks the schedule every `everyMs` while the app is open. Runs are never queued up for a closed app. */
  start(everyMs = 15 * 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Two folders can share a leaf name (`D:\Music` and `E:\Music`); the second gets a suffix. */
function uniqueName(leaf: string, all: readonly string[], mine: string): string {
  const same = all.filter((p) => (basename(p) || p) === leaf);
  if (same.length < 2) return leaf;
  return `${leaf}-${same.indexOf(mine) + 1}`;
}

/**
 * Copy a folder, file by file, reporting bytes as they land. Symbolic links are skipped and a file
 * with several hard links is linked, not copied, past its first appearance — the same rules
 * `measureFolder` counts by, so the archive is as big as the estimate said.
 */
async function copyTree(source: string, target: string, done: number, onProgress: (done: number, name: string) => void): Promise<number> {
  const seen = new Map<string, string>();
  const pending: Array<{ from: string; to: string }> = [{ from: source, to: target }];
  while (pending.length) {
    const { from, to } = pending.pop()!;
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      if (entry.isDirectory()) {
        pending.push({ from: src, to: dst });
        continue;
      }
      if (!entry.isFile()) continue;
      const s = await lstat(src, { bigint: true });
      if (s.nlink > 1n) {
        const key = `${s.dev}:${s.ino}`;
        const first = seen.get(key);
        if (first) {
          await link(first, dst).catch(() => copyFile(src, dst));
          continue;
        }
        seen.set(key, dst);
      }
      await copyFile(src, dst);
      done += Number(s.size);
      onProgress(done, entry.name);
    }
  }
  return done;
}

/** Decimal units, as the player's Backup pane shows them (1 GB = 10⁹ bytes). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
}

export { measureFolder };
