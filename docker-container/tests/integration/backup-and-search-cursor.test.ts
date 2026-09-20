/**
 * Backup restore answers success once the database has been swapped (the audit entry is written
 * before the live handle closes), pruning keeps the operator's own backups, and a bogus search
 * cursor is a client error rather than a server one.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
/**
 * Exit codes the hub asked for. A successful restore closes the database and then ends the process,
 * so the exit is injected rather than taken: a real `process.exit` would end this suite, and spying
 * on the global is not enough because the call is deferred past the test that caused it.
 */
let exits: number[] = [];

beforeEach(async () => {
  exits = [];
  hub = await createTestHub({ deps: { exit: (code: number) => void exits.push(code) } });
  admin = await hub.completeSetup();
});

afterEach(async () => {
  await hub.dispose();
});

/** The exit is deferred with `setImmediate` so the response is written first. */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('backup restore', () => {
  it('restores, answers 200 with the safety backup id, and records the restore in the restored-away database', async () => {
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    const created = await hub.app.inject({ method: 'POST', url: '/api/v1/backup', headers });
    expect(created.statusCode).toBe(201);
    const backupId = (created.json() as { id: string }).id;

    hub.clock.advance(2000);
    const restored = await hub.app.inject({ method: 'POST', url: `/api/v1/backup/${backupId}/restore`, headers, payload: { confirm: true } });
    expect(restored.statusCode, restored.body).toBe(200);
    const body = restored.json() as { ok: boolean; safetyBackupId: string; restartRequired: boolean };
    expect(body).toMatchObject({ ok: true, restartRequired: true });
    expect(body.safetyBackupId).toMatch(/-safety$/);

    const dataDir = hub.dataDir;
    const replaced = join(dataDir, 'hub.sqlite.replaced');
    expect(existsSync(join(dataDir, 'hub.sqlite'))).toBe(true);
    expect(existsSync(replaced)).toBe(true);
    expect(existsSync(join(dataDir, 'hub.sqlite.restoring'))).toBe(false);

    // The audit entry lives in the database that was live when the restore was requested.
    const previous = new Database(replaced, { readonly: true });
    try {
      const row = previous.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'backup.restore'").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      previous.close();
    }
  });

  /**
   * A restore closes the database for good. Before this, the process stayed up and `/healthz` kept
   * answering `ok` while every request that touched the database failed — a live-but-dead container
   * with a passing healthcheck, which `restart: unless-stopped` had no reason to replace.
   */
  it('reports itself unhealthy and exits so the supervisor restarts it', async () => {
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    const created = await hub.app.inject({ method: 'POST', url: '/api/v1/backup', headers });
    const backupId = (created.json() as { id: string }).id;

    const before = await hub.app.inject({ method: 'GET', url: '/healthz' });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { status: string }).status).toBe('ok');

    hub.clock.advance(2000);
    exits.length = 0;
    expect((await hub.app.inject({ method: 'POST', url: `/api/v1/backup/${backupId}/restore`, headers, payload: { confirm: true } })).statusCode).toBe(200);

    // Deferred with `setImmediate`, so the 200 above is written before the process ends — the
    // operator sees the result of the restore they asked for rather than a dropped connection.
    await nextTick();
    expect(exits).toEqual([0]);

    const after = await hub.app.inject({ method: 'GET', url: '/healthz' });
    expect(after.statusCode).toBe(503);
    expect((after.json() as { status: string }).status).toBe('db-closed');
  });

  it('refuses a missing backup without touching the live database', async () => {
    const headers = { cookie: admin.cookie, 'x-csrf-token': admin.csrfToken };
    const response = await hub.app.inject({ method: 'POST', url: '/api/v1/backup/backup-20260101T000000Z/restore', headers, payload: { confirm: true } });
    expect(response.statusCode).toBe(404);
    // Still serving.
    const list = await hub.app.inject({ method: 'GET', url: '/api/v1/backup', headers });
    expect(list.statusCode).toBe(200);
  });

  it('prunes scheduled and safety backups but never the operator’s own', async () => {
    const actor = { id: 'admin', displayName: 'Admin' };
    const meta = { ip: null, userAgent: null, correlationId: null };
    for (let i = 0; i < 12; i += 1) {
      hub.clock.advance(1000);
      await hub.ctx.backup.create(actor, meta, 'manual');
      hub.clock.advance(1000);
      await hub.ctx.backup.create(null, null, 'auto');
      hub.clock.advance(1000);
      await hub.ctx.backup.create(actor, meta, 'safety');
    }
    const ids = hub.ctx.backup.list().map((b) => b.id);
    expect(ids.filter((id) => id.endsWith('-auto'))).toHaveLength(10);
    expect(ids.filter((id) => id.endsWith('-safety'))).toHaveLength(10);
    expect(ids.filter((id) => !id.endsWith('-auto') && !id.endsWith('-safety'))).toHaveLength(12);
    // The newest of each kind survive.
    const autos = ids.filter((id) => id.endsWith('-auto'));
    expect(autos[0]! > autos[autos.length - 1]!).toBe(true);
  });
});

describe('search cursor', () => {
  it('answers 400 for a cursor this hub did not issue', async () => {
    const device = await pairDevice(hub, admin);
    for (const cursor of ['bm90IGpzb24', Buffer.from('[1,2]').toString('base64url'), Buffer.from('{"hub":5}').toString('base64url')]) {
      const response = await hub.app.inject({ method: 'GET', url: `/api/v1/search?q=test&cursor=${cursor}`, headers: { authorization: device.authorization } });
      expect(response.statusCode, cursor).toBe(400);
      expect((response.json() as { detail: string }).detail).toMatch(/cursor/i);
    }
  });
});
