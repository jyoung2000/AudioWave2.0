/**
 * Library scans must not mistake "unreadable" for "deleted", track ids must survive a root being
 * removed and re-added (or a file moving), and byte-range streaming must follow RFC 9110.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '@now-playing/domain';
import { parseRange, RangeNotSatisfiableError } from '../../src/library/service.js';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

/** Directory names the test marks unreadable; `readdir` on them fails like EACCES would. */
const { locked } = vi.hoisted(() => ({ locked: new Set<string>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readdir: (async (path: Parameters<typeof actual.readdir>[0], options?: unknown) => {
      if ([...locked].some((name) => String(path).endsWith(name))) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), { code: 'EACCES' });
      }
      return (actual.readdir as (p: unknown, o?: unknown) => Promise<unknown>)(path, options);
    }) as typeof actual.readdir,
  };
});

const meta = { ip: null, userAgent: null, correlationId: null };
const actor = { id: 'admin', displayName: 'Admin' };

let hub: TestHub;
let musicDir: string;

beforeEach(async () => {
  locked.clear();
  hub = await createTestHub();
  musicDir = join(hub.dataDir, 'library', 'music');
  mkdirSync(join(musicDir, 'albums', 'one'), { recursive: true });
  writeFileSync(join(musicDir, 'loose.mp3'), 'loose track bytes');
  writeFileSync(join(musicDir, 'albums', 'one', 'first.mp3'), 'first track bytes');
  writeFileSync(join(musicDir, 'albums', 'one', 'second.mp3'), 'second track bytes');
});

afterEach(async () => {
  locked.clear();
  await hub.dispose();
});

function idsByPath(rootId: string): Record<string, string> {
  return Object.fromEntries(hub.ctx.library.tracksForRoot(rootId).map((t) => [t.relativePath, t.id]));
}

describe('library scan safety', () => {
  it('does not tombstone anything when the root itself cannot be read', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    expect(hub.ctx.library.count()).toBe(3);

    locked.add('music');
    await expect(hub.ctx.library.scanRoot(root.id)).rejects.toThrow(/could not be read/);
    expect(hub.ctx.library.count()).toBe(3);
    expect(hub.ctx.repos.library.findRoot(root.id)?.status).toBe('error');
  });

  it('keeps tracks under a sub-directory that cannot be read, and reports it', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);

    locked.add('one');
    const report = await hub.ctx.library.scanRoot(root.id);
    expect(report.removed).toBe(0);
    expect(report.skipped.some((s) => s.path === 'albums/one')).toBe(true);
    expect(hub.ctx.library.count()).toBe(3);

    // Genuinely deleted files are still tombstoned.
    locked.clear();
    rmSync(join(musicDir, 'loose.mp3'));
    const after = await hub.ctx.library.scanRoot(root.id);
    expect(after.removed).toBe(1);
    expect(hub.ctx.library.count()).toBe(2);
  });
});

describe('stable track ids', () => {
  it('gives tracks their old ids back when a removed root is added again', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    const before = idsByPath(root.id);

    hub.ctx.library.removeRoot(root.id, meta, actor);
    expect(hub.ctx.library.count()).toBe(0);
    expect(hub.ctx.library.listRoots()).toHaveLength(0);

    const again = hub.ctx.library.addRoot('music', 'Music again', meta, actor);
    expect(again.id).toBe(root.id);
    await hub.ctx.library.scanRoot(again.id);
    expect(idsByPath(again.id)).toEqual(before);
    expect(hub.ctx.library.findTrack(before['loose.mp3']!)).toBeDefined();
  });

  it('keeps the id of a file that moved inside the root', async () => {
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    const before = idsByPath(root.id);

    mkdirSync(join(musicDir, 'moved'));
    renameSync(join(musicDir, 'loose.mp3'), join(musicDir, 'moved', 'loose-renamed.mp3'));
    await hub.ctx.library.scanRoot(root.id);
    const after = idsByPath(root.id);
    expect(after['moved/loose-renamed.mp3']).toBe(before['loose.mp3']);
    expect(after['loose.mp3']).toBeUndefined();
    expect(hub.ctx.library.count()).toBe(3);
  });
});

describe('Range parsing', () => {
  it('serves a single satisfiable range as partial content', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3, partial: true });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9, partial: true });
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9, partial: true });
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9, partial: true });
    expect(parseRange(undefined, 10)).toEqual({ start: 0, end: 9, partial: false });
  });

  it('ignores multi-range requests and serves the whole file', () => {
    expect(parseRange('bytes=0-1, 4-5', 10)).toEqual({ start: 0, end: 9, partial: false });
  });

  it('rejects malformed headers, including a range with neither end', () => {
    for (const header of ['bytes=-', 'bytes=abc', 'items=0-1', 'bytes=5-2']) {
      let error: unknown = null;
      try {
        parseRange(header, 10);
      } catch (err) {
        error = err;
      }
      expect(error, header).toBeInstanceOf(DomainError);
      expect((error as DomainError).status, header).toBe(400);
    }
  });

  it('answers an unsatisfiable range with 416 and the size for Content-Range', () => {
    for (const [header, size] of [
      ['bytes=10-', 10],
      ['bytes=-0', 10],
      ['bytes=0-', 0],
    ] as const) {
      let error: unknown = null;
      try {
        parseRange(header, size);
      } catch (err) {
        error = err;
      }
      expect(error, header).toBeInstanceOf(RangeNotSatisfiableError);
      expect((error as RangeNotSatisfiableError).status).toBe(416);
      expect((error as RangeNotSatisfiableError).details).toMatchObject({ contentRange: `bytes */${size}` });
    }
  });

  it('streams an empty file without failing, and returns 416 over HTTP for an unsatisfiable range', async () => {
    writeFileSync(join(musicDir, 'empty.mp3'), '');
    const root = hub.ctx.library.addRoot('music', 'Music', meta, actor);
    await hub.ctx.library.scanRoot(root.id);
    const empty = hub.ctx.library.tracksForRoot(root.id).find((t) => t.relativePath === 'empty.mp3')!;
    const opened = hub.ctx.library.openRange(empty.id, undefined);
    expect(opened.end - opened.start + 1).toBe(0);
    const chunks: unknown[] = [];
    for await (const chunk of opened.stream as AsyncIterable<unknown>) chunks.push(chunk);
    expect(chunks).toEqual([]);

    const admin = await hub.completeSetup();
    const device = await pairDevice(hub, admin);
    const loose = hub.ctx.library.tracksForRoot(root.id).find((t) => t.relativePath === 'loose.mp3')!;
    const response = await hub.app.inject({ method: 'GET', url: `/api/v1/library/stream/${loose.id}`, headers: { authorization: device.authorization, range: 'bytes=999999-' } });
    expect(response.statusCode).toBe(416);
  });
});
