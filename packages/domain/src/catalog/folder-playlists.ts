/**
 * The words the hub's and the companion's playlist folders show (DEC-041; UX-PL-006, CMP-PL-005):
 * one place, so the two apps say the same thing about the same files.
 */
import { CATALOG_PLATFORM_LABELS, type FolderPlaylistEntry, type FolderPlaylistSummary } from '@now-playing/contracts';

/** "1 h 5 min", "42 min": a playlist's length. */
export function playlistLengthText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The line under a playlist's name: "12 songs · 48 min", and "made outside Airwave" for a hand-made list. */
export function folderPlaylistLine(p: Pick<FolderPlaylistSummary, 'entryCount' | 'durationSec' | 'readOnly'>): string {
  const songs = p.entryCount === 1 ? '1 song' : `${p.entryCount.toLocaleString('en')} songs`;
  return [songs, p.durationSec ? playlistLengthText(p.durationSec) : null, p.readOnly ? 'made outside Airwave' : null].filter(Boolean).join(' · ');
}

/** Where an entry plays from, in words. */
export function folderEntryWhere(entry: Pick<FolderPlaylistEntry, 'locationKind' | 'platforms' | 'sources'>): string {
  if (entry.locationKind === 'library') return 'In the library';
  if (entry.locationKind === 'url') {
    const platform = entry.platforms[0] ?? entry.sources[0]?.platform;
    return platform ? `Plays from ${CATALOG_PLATFORM_LABELS[platform]}` : 'Plays from its link';
  }
  return 'Not found: the file isn’t where the list says';
}
