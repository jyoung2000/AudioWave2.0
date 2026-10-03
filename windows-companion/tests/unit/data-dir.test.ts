/**
 * Where the companion keeps its data — and that renaming the product did not move it.
 *
 * Electron names an installed app's data folder after the product. The product became Airwave
 * Companion; a person who installed it as Now Playing Companion must still find their library, their
 * hub pairing and their helper token when the renamed build starts.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_PRODUCT_FOLDER, PORTABLE_DATA_FOLDER, resolveDataDir } from '../../src/main/data-dir.js';

const appData = join('C:', 'Users', 'Sam', 'AppData', 'Roaming');
const userData = join(appData, 'Airwave Companion');
const legacy = join(appData, LEGACY_PRODUCT_FOLDER);
const having = (...files: string[]) => (path: string) => files.includes(path);

describe('the data folder', () => {
  it('is beside the .exe for the portable build, under the name it has always had', () => {
    const stick = join('E:', 'Apps');
    expect(resolveDataDir({ portableRoot: stick, userData, appData, exists: having() })).toBe(join(stick, 'NowPlayingCompanion-data'));
    expect(PORTABLE_DATA_FOLDER).toBe('NowPlayingCompanion-data');
    // A library in the profile does not pull a portable copy off its stick.
    expect(resolveDataDir({ portableRoot: stick, userData, appData, exists: having(join(legacy, 'companion.sqlite')) })).toBe(join(stick, 'NowPlayingCompanion-data'));
  });

  it('is the product’s own folder on a new installation', () => {
    expect(resolveDataDir({ portableRoot: undefined, userData, appData, exists: having() })).toBe(userData);
  });

  it('stays where it was for an installation made under the old name', () => {
    expect(resolveDataDir({ portableRoot: undefined, userData, appData, exists: having(join(legacy, 'companion.sqlite')) })).toBe(legacy);
  });

  it('does not go back to the old folder once the new one holds a library', () => {
    expect(resolveDataDir({ portableRoot: undefined, userData, appData, exists: having(join(legacy, 'companion.sqlite'), join(userData, 'companion.sqlite')) })).toBe(userData);
  });

  it('gives the same answer when asked again after Electron has been pointed at it', () => {
    // index.ts calls app.setPath('userData', dir); later calls see that folder as `userData`.
    expect(resolveDataDir({ portableRoot: undefined, userData: legacy, appData, exists: having(join(legacy, 'companion.sqlite')) })).toBe(legacy);
  });
});
