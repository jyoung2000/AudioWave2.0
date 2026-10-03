/**
 * The companion's own files that are not settings: how big its caches are, and where a finished
 * download is saved.
 *
 * The cache Settings shows is three things the companion can fetch again: Electron's own web cache
 * (the window's), the parsed Live TV playlists and guides, and what the helper keeps of downloads
 * the player has not collected. Clear Cache empties all three; nothing else is touched.
 *
 * Nothing here touches Electron, so the tests drive it against a temporary folder.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { sanitizeFilename } from '@now-playing/domain';

/** Everything under a folder, in bytes. A folder that is not there is empty; one that cannot be read counts what could. */
export async function folderBytes(dir: string, depth = 0): Promise<number> {
  if (depth > 12) return 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await folderBytes(path, depth + 1);
    else if (entry.isFile()) total += await stat(path).then((s) => s.size).catch(() => 0);
  }
  return total;
}

/**
 * Copies a finished download's files into the folder chosen for downloads, keeping each name and
 * numbering one that is already there (`Song (2).opus`) rather than replacing it. The name is
 * cleaned again here: it came from a web page title. Returns where each file went.
 */
export async function saveDownload(files: ReadonlyArray<{ name: string; path: string }>, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  for (const file of files) {
    const extension = extname(file.name);
    const base = sanitizeFilename(file.name, { fallback: `download${extension}` });
    const stem = base.slice(0, base.length - extname(base).length) || 'download';
    for (let n = 1; n < 1000; n += 1) {
      const target = join(dir, n === 1 ? base : `${stem} (${n})${extname(base)}`);
      try {
        // COPYFILE_EXCL: never over a file that is already there, even one that appeared just now.
        await copyFile(file.path, target, 1);
        saved.push(target);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }
  return saved;
}
