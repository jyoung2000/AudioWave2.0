import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureWritableDataDir } from '../../src/data-dir.js';

/**
 * The hub's first act: prove it can write where it keeps everything. A data directory it cannot
 * write used to surface as a database error deep inside startup, after `docker compose up` had
 * already reported success; now it is the first line of output and names the fix.
 */
describe('ensureWritableDataDir', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'np-datadir-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a missing directory and leaves no probe behind', () => {
    const dir = join(root, 'fresh', 'data');
    ensureWritableDataDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('names the directory and the fix when it cannot be written', async () => {
    // A file where the directory should be: the cheapest cross-platform "cannot write here".
    const blocked = join(root, 'data');
    await writeFile(blocked, 'not a directory');
    expect(() => ensureWritableDataDir(blocked)).toThrow(/cannot write to its data directory/);
    expect(() => ensureWritableDataDir(blocked)).toThrow(blocked);
    expect(() => ensureWritableDataDir(blocked)).toThrow(/chown -R 1000:1000/);
  });
});
