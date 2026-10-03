/**
 * Where this installation keeps its database, logs and pairings.
 *
 * The portable build sets `PORTABLE_EXECUTABLE_DIR` to the folder holding the .exe, and the data
 * goes there rather than into the Windows user profile. That is the whole point of a portable
 * build: run it from a USB stick, take the stick away, and nothing of yours is left on the machine.
 * Installed builds use the per-user application-data folder.
 *
 * Two names here are machine identifiers, not branding, and stay as they were when the product was
 * called Now Playing Companion:
 *
 *   - the portable folder, `NowPlayingCompanion-data`, so a stick that already holds a library
 *     still opens it;
 *   - an installed copy's folder. Electron names it after the product, so renaming the product to
 *     Airwave Companion would have pointed an existing installation at a new, empty folder — the
 *     library, the pairing and the helper token apparently gone. An installation that has a
 *     database under the old name and none under the new keeps using the old folder.
 *
 * Kept free of Electron so the rule can be tested as the plain decision it is.
 */
import { join } from 'node:path';

export const PORTABLE_DATA_FOLDER = 'NowPlayingCompanion-data';
export const LEGACY_PRODUCT_FOLDER = 'Now Playing Companion';
const DATABASE = 'companion.sqlite';

export interface DataDirInputs {
  /** `PORTABLE_EXECUTABLE_DIR`, when this is the portable build. */
  portableRoot: string | undefined;
  /** Electron's `userData` for the product as it is named now. */
  userData: string;
  /** Electron's `appData`: the per-user folder the product folders live in. */
  appData: string;
  exists: (path: string) => boolean;
}

export function resolveDataDir({ portableRoot, userData, appData, exists }: DataDirInputs): string {
  if (portableRoot) return join(portableRoot, PORTABLE_DATA_FOLDER);
  const legacy = join(appData, LEGACY_PRODUCT_FOLDER);
  if (legacy !== userData && !exists(join(userData, DATABASE)) && exists(join(legacy, DATABASE))) return legacy;
  return userData;
}
