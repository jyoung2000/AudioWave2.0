/**
 * How big a folder is, and how much room a drive has — the two numbers a backup needs before it
 * starts. The player's Backup pane and the companion's own Backup view both read these, so the two
 * can never disagree about the same folder.
 *
 * A number here is either measured or absent. A folder that could not be finished inside the budget
 * is left out, never reported as 0: "0 bytes" is a claim, and an unfinished walk has not earned it.
 */
import { lstat, readdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const BACKUP_PARTS = ['music', 'tv', 'movies'] as const;
export type BackupPart = (typeof BACKUP_PARTS)[number];

export interface FolderMeasure {
  bytes: number;
  files: number;
  measuredAt: string;
}

export interface MeasureOptions {
  /** Epoch milliseconds after which the walk gives up. */
  deadline: number;
  now?: () => number;
}

/**
 * Recursive size of a folder. Symbolic links are skipped (a link out of the folder is not part of
 * it, and a link back into it would never end); a file with several hard links is counted once.
 * Returns null when the folder is missing or the deadline passed before the walk finished.
 */
export async function measureFolder(root: string, options: MeasureOptions): Promise<FolderMeasure | null> {
  const now = options.now ?? Date.now;
  const seenLinks = new Set<string>();
  let bytes = 0;
  let files = 0;
  const pending: string[] = [root];
  try {
    if (!(await lstat(root)).isDirectory()) return null;
  } catch {
    return null;
  }
  while (pending.length) {
    if (now() > options.deadline) return null;
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable subfolder: what can be read is still worth reporting
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // bigint: on Windows the file index does not fit a double, and two files would collide.
        const s = await lstat(full, { bigint: true });
        if (s.nlink > 1n) {
          const key = `${s.dev}:${s.ino}`;
          if (seenLinks.has(key)) continue;
          seenLinks.add(key);
        }
        bytes += Number(s.size);
        files += 1;
      } catch {
        continue;
      }
    }
  }
  return { bytes, files, measuredAt: new Date(now()).toISOString() };
}

/** Free and total bytes of the drive holding `dir`; nulls when it cannot be asked. */
export async function driveSpace(dir: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  // A backup folder that has not been created yet still lives on a drive: ask its nearest ancestor.
  let at = dir;
  for (;;) {
    try {
      const s = await statfs(at);
      return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      const parent = dirname(at);
      if (parent === at) return { freeBytes: null, totalBytes: null };
      at = parent;
    }
  }
}

export interface EstimatorOptions {
  folders: Partial<Record<BackupPart, string | null | undefined>>;
  backupDir: string | null;
  /** One request's whole budget. Default 20 s. */
  budgetMs?: number;
  /** How long a finished measurement is reused. Default 10 minutes. */
  cacheMs?: number;
  now?: () => number;
}

export interface BackupEstimate {
  parts: Partial<Record<BackupPart, FolderMeasure>>;
  destination: { path: string; freeBytes: number | null; totalBytes: number | null } | null;
}

/** Measures the configured folders, remembering each result per folder for `cacheMs`. */
export function createEstimator(options: EstimatorOptions): (parts: readonly BackupPart[]) => Promise<BackupEstimate> {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: FolderMeasure }>();
  return async (parts) => {
    const deadline = now() + (options.budgetMs ?? 20_000);
    const out: BackupEstimate = { parts: {}, destination: null };
    for (const part of parts) {
      const folder = options.folders[part];
      if (!folder) continue;
      const cached = cache.get(folder);
      if (cached && now() - cached.at < (options.cacheMs ?? 10 * 60_000)) {
        out.parts[part] = cached.value;
        continue;
      }
      const measured = await measureFolder(folder, { deadline, now });
      if (!measured) continue;
      cache.set(folder, { at: now(), value: measured });
      out.parts[part] = measured;
    }
    if (options.backupDir) out.destination = { path: options.backupDir, ...(await driveSpace(options.backupDir)) };
    return out;
  };
}
