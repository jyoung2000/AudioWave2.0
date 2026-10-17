import type { HelperStatus, Preferences } from '../../shared/ipc.js';

/** The address the Music Player can use for this Companion on the same PC. */
export function playerHelperAddress(
  helper: Pick<HelperStatus, 'running' | 'port' | 'origin'> | null,
  preferences: Pick<Preferences, 'helperPort'> | null,
): string {
  if (helper?.running && helper.origin) return helper.origin.replace(/\/$/, '');
  const port = helper?.running ? helper.port : null;
  return `http://127.0.0.1:${port ?? preferences?.helperPort ?? 17342}`;
}
