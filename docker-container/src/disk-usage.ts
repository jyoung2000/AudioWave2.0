/**
 * Free and total bytes of the filesystem holding `dir`. Shared by the downloads storage view and the
 * backup space route so the two can never disagree about the same volume.
 *
 * Unknown is reported as null, never as zero: a caller that shows "0 bytes free" for a directory
 * that merely does not exist yet would be stating something it has not measured.
 */
export async function diskUsage(dir: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    const { statfs } = await import('node:fs/promises');
    const fs = await statfs(dir);
    return { freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize) };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}
