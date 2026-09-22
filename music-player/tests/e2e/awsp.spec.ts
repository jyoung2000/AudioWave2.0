/**
 * Streaming from a PC, end to end (docs/AWSP.md §6, §8): a real browser, the real sidecar, a real
 * relay — nothing stubbed.
 *
 * Before the test: a 24-bit / 96 kHz FLAC is generated with ffmpeg; a companion library database
 * (the tables of windows-companion/src/main/store.ts) is written with one track pointing at it; a
 * local `iroh-relay --dev` (1.2.0, plain HTTP, which a page on 127.0.0.1 may reach) is started on a
 * free port; and the sidecar `awsp-server` is started relay-only (`AWSP_RELAY_ONLY=1`, relay_mode
 * custom) against that relay. Its `ready` ticket and a `new_pairing_code` are what a person would
 * read off the PC.
 *
 * The page pairs through Settings ▸ Sources ▸ Connections ▸ Stream from a PC; the PC's track joins the
 * library; it plays through the service worker's `/awsp/track/<id>`, and the indicator says
 * `relay-carried`. Then the bytes are checked: the whole file fetched through the bridge is
 * bit-identical to the source (SHA-256), and a Range request returns exactly that range. Last, the
 * relay is killed mid-stream and restarted on the same port: the client notices (three missed pongs),
 * reconnects with its resume token, and the interrupted fetch resumes from the last contiguous byte it
 * held and completes byte-identical.
 *
 * Needs: ffmpeg on PATH, `iroh-relay` (cargo install iroh-relay --version =1.2.0 --features server
 * --locked) and the sidecar built (cargo build --release in windows-companion/awsp-server). Without
 * them the test is skipped and says which is missing — never passed.
 */
import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { boot, leavePrefs, resetToLibrary, stubOffline, watchErrors } from './np/_shell.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const SIDECAR = join(repo, 'windows-companion', 'awsp-server', 'target', 'release', `awsp-server${exe}`);
const RELAY = [process.env['AWSP_IROH_RELAY'], join(homedir(), '.cargo', 'bin', `iroh-relay${exe}`)].find((p): p is string => !!p && existsSync(p)) ?? null;
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const missing = [!hasFfmpeg && 'ffmpeg', !RELAY && 'iroh-relay 1.2.0', !existsSync(SIDECAR) && 'the awsp-server release build'].filter(Boolean);

const TRACK_ID = randomUUID();
const TITLE = 'Harbour Lights (24-96)';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let dir = '';
let fixture: Buffer = Buffer.alloc(0);
let relayPort = 0;
let relay: ChildProcessWithoutNullStreams | null = null;
let sidecar: ChildProcessWithoutNullStreams | null = null;
const sidecarLog: string[] = [];
const events: Array<Record<string, unknown>> = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function startRelay(): Promise<void> {
  relay = spawn(RELAY!, ['--dev', '--config-path', join(dir, 'relay.toml')], { stdio: 'pipe' });
  relay.stdout.resume();
  relay.stderr.resume();
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${relayPort}/`);
      if (r.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the relay did not start');
}

function stopRelay(): Promise<void> {
  const r = relay;
  relay = null;
  if (!r || r.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    r.once('exit', () => resolve());
    r.kill();
  });
}

async function nextEvent(kind: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const i = events.findIndex((e) => e['event'] === kind);
    if (i >= 0) return events.splice(i, 1)[0]!;
    if (Date.now() > deadline) throw new Error(`no ${kind} event from the sidecar; its log:\n${sidecarLog.slice(-20).join('\n')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function send(cmd: Record<string, unknown>): void {
  sidecar!.stdin.write(JSON.stringify(cmd) + '\n');
}

test.describe('streaming from a PC (AWSP)', () => {
  test.use({ serviceWorkers: 'allow' });
  test.skip(missing.length > 0, `SKIPPED: needs ${missing.join(', ')}`);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dir = mkdtempSync(join(tmpdir(), 'np-awsp-e2e-'));

    // The fixture: 20 s of decorrelated pink noise at 24-bit / 96 kHz — near-incompressible, so the
    // stream is a realistic hi-res size (~10 MB) and the relay can be killed while it is under way.
    const flac = join(dir, 'music', 'hires-20s.flac');
    mkdirSync(join(dir, 'music'));
    const graph = 'anoisesrc=r=96000:d=20:c=pink:a=0.25:seed=1[l];anoisesrc=r=96000:d=20:c=pink:a=0.25:seed=2[r];[l][r]amerge=inputs=2[out]';
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-y', '-filter_complex', graph, '-map', '[out]', '-ac', '2', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-c:a', 'flac', flac]);
    expect(ff.status, String(ff.stderr)).toBe(0);
    fixture = readFileSync(flac);

    // The companion's library, as the sidecar reads it (store.ts's tables; awsp-server tests/common).
    const db = new DatabaseSync(join(dir, 'companion.sqlite'));
    db.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, watch INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'music', track_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_scan_error TEXT, created_at TEXT NOT NULL);
      CREATE TABLE tracks (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, relative_path TEXT NOT NULL, track TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_hash TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(folder_id, relative_path));
      CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, tokenize='unicode61 remove_diacritics 2');`);
    db.prepare(`INSERT INTO folders (id, path, display_name, created_at) VALUES ('folder-1', ?, 'Music', '2026-01-01T00:00:00Z')`).run(join(dir, 'music'));
    const track = { id: TRACK_ID, title: TITLE, artistName: 'Alder Quartet', albumName: 'Remote Sessions', durationMs: 20_000, format: { codec: 'flac', sampleRateHz: 96000, lossless: true } };
    db.prepare(`INSERT INTO tracks (id, folder_id, relative_path, track, size_bytes, mtime_ms, updated_at) VALUES (?, 'folder-1', 'hires-20s.flac', ?, ?, 1, '2026-01-01T00:00:00Z')`).run(TRACK_ID, JSON.stringify(track), fixture.length);
    db.prepare(`INSERT INTO tracks_fts (rowid, title, artist, album) SELECT rowid, ?, 'Alder Quartet', 'Remote Sessions' FROM tracks WHERE id = ?`).run(TITLE, TRACK_ID);
    db.close();

    relayPort = await freePort();
    writeFileSync(join(dir, 'relay.toml'), `http_bind_addr = "127.0.0.1:${relayPort}"\nenable_metrics = false\n`);
    await startRelay();

    sidecar = spawn(SIDECAR, [], { stdio: 'pipe', env: { ...process.env, AWSP_RELAY_ONLY: '1', AWSP_LOG: 'info' } });
    createInterface({ input: sidecar.stdout }).on('line', (line) => {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        sidecarLog.push(`stdout: ${line}`);
      }
    });
    createInterface({ input: sidecar.stderr }).on('line', (line) => sidecarLog.push(line));
    sidecar.stdin.write(JSON.stringify({
      secret_key_hex: randomBytes(32).toString('hex'),
      library_db: join(dir, 'companion.sqlite'),
      cache_dir: join(dir, 'cache'),
      server_name: 'Test PC',
      allowlist: [],
      relay_mode: 'custom',
      relay_urls: [`http://127.0.0.1:${relayPort}`],
      relay_only: false, // forced on by AWSP_RELAY_ONLY=1, as §0 says
      bind_port: null,
      insecure_relay_tls: false,
    }) + '\n');
  });

  test.afterAll(async () => {
    if (sidecar && sidecar.exitCode === null) {
      send({ cmd: 'shutdown' });
      await Promise.race([new Promise((r) => sidecar!.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
      if (sidecar.exitCode === null) sidecar.kill();
    }
    await stopRelay();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('pairs, plays relay-carried, is bit-identical, seeks by range, and resumes across a relay restart', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = watchErrors(page);
    const infos: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'info') infos.push(m.text());
    });
    await stubOffline(page);

    const ready = await nextEvent('ready');
    const ticket = String(ready['ticket']);
    expect(ticket).toMatch(/^endpoint[a-z2-7]+$/);
    expect(ready['relay_url'], 'the sidecar reached the local relay, so its ticket carries it').toBe(`http://127.0.0.1:${relayPort}/`);
    send({ cmd: 'new_pairing_code' });
    const code = String((await nextEvent('pairing_code'))['code']);
    expect(code).toMatch(/^\d{6}$/);

    await boot(page);
    // The bridge is the service worker: it must control this page (it claims the first visit).
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
    // Liveness at 1 s instead of 5 s, so three missed pongs take seconds, not a quarter-minute.
    await page.evaluate(() => window.NP_AWSP_READY!.then((a) => a!.tune({ pingMs: 1000 })));

    await test.step('pair through Settings ▸ Sources ▸ Connections', async () => {
      await page.evaluate(() => { location.hash = '#settings/src'; });
      await expect(page.locator('#pp-src')).toBeVisible({ timeout: 5000 });
      await page.fill('#pcTicket', ticket);
      await page.fill('#pcCode', code);
      await page.click('#pcPair');
      await expect(page.locator('#pcMsg')).toHaveText('Paired with Test PC.', { timeout: 30_000 });
      await expect(page.locator('#connPcDot')).toHaveAttribute('data-state', 'ok');
      await expect(page.locator('#pcFacts')).toContainText('relay-carried');
      await expect(page.locator('#pcFacts')).toContainText('Test PC');
      const paired = await nextEvent('paired');
      expect(paired['client_kind']).toBe('pwa');
    });

    const rowId = `awsp:${TRACK_ID}`;
    await test.step('the PC’s track joins the library', async () => {
      await expect(page.locator('#pcFacts')).toContainText(/Tracks\s*1/, { timeout: 15_000 });
      await leavePrefs(page);
      await expect.poll(() => page.evaluate((id) => (window.LIBRARY ?? []).some((r) => r.id === id && (r as { remote?: boolean }).remote === true), rowId)).toBe(true);
      await resetToLibrary(page);
      await expect(page.locator(`#libraryRows tr[data-id="${rowId}"] .lib-title`)).toHaveText(TITLE);
    });

    await test.step('it plays through the service worker, relay-carried', async () => {
      await page.click(`#libraryRows tr[data-id="${rowId}"] .lib-title`);
      await expect(page.locator('.player__title')).toHaveText(TITLE);
      await expect.poll(() => page.evaluate(() => window.NP_PLAYER!.playing()), { timeout: 20_000 }).toBe(true);
      const first = await page.evaluate(() => window.NP_PLAYER!.position());
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => window.NP_PLAYER!.position()), 'the element is playing the stream').toBeGreaterThan(first + 0.8);
      await expect(page.locator('#npConn')).toHaveText('relay-carried');
      await expect(page.locator('#npConn')).toBeVisible();
      expect(await page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(TITLE);
      // Both sides log the connection type at INFO (§5).
      expect(infos.some((l) => /^awsp connection [0-9a-f]{64} type=relay/.test(l)), infos.join('\n')).toBe(true);
      expect(sidecarLog.some((l) => /INFO .*awsp connection [0-9a-f]{64} type=relay/.test(l)), sidecarLog.join('\n')).toBe(true);
      await page.evaluate(() => window.NP_PLAYER!.pause());
    });

    const url = `/awsp/track/${TRACK_ID}`;
    await test.step('the whole file through the bridge is bit-identical to the source', async () => {
      const got = await page.evaluate(async (u) => {
        const r = await fetch(u + '?tag=whole');
        const bytes = new Uint8Array(await r.arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
        return { status: r.status, type: r.headers.get('content-type'), length: r.headers.get('content-length'), ranges: r.headers.get('accept-ranges'), size: bytes.length, hash };
      }, url);
      expect(got).toEqual({ status: 200, type: 'audio/flac', length: String(fixture.length), ranges: 'bytes', size: fixture.length, hash: sha256(fixture) });
    });

    await test.step('a Range request (a seek) returns exactly that range', async () => {
      const start = 1_000_003;
      const end = start + 300_000;
      const got = await page.evaluate(async ({ u, start, end }) => {
        const r = await fetch(u, { headers: { Range: `bytes=${start}-${end}` } });
        const bytes = new Uint8Array(await r.arrayBuffer());
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
        return { status: r.status, range: r.headers.get('content-range'), length: r.headers.get('content-length'), size: bytes.length, hash };
      }, { u: url, start, end });
      expect(got).toEqual({ status: 206, range: `bytes ${start}-${end}/${fixture.length}`, length: String(end - start + 1), size: end - start + 1, hash: sha256(fixture.subarray(start, end + 1)) });
      // An open-ended range from the middle to the end, as a media element asks after a seek.
      const tail = await page.evaluate(async ({ u, from }) => {
        const r = await fetch(u, { headers: { Range: `bytes=${from}-` } });
        return { status: r.status, range: r.headers.get('content-range'), size: (await r.arrayBuffer()).byteLength };
      }, { u: url, from: fixture.length - 12_345 });
      expect(tail).toEqual({ status: 206, range: `bytes ${fixture.length - 12_345}-${fixture.length - 1}/${fixture.length}`, size: 12_345 });
      // Past the end is refused as HTTP says.
      expect(await page.evaluate(async (u) => (await fetch(u, { headers: { Range: 'bytes=999999999-' } })).status, url)).toBe(416);
    });

    await test.step('the relay dies mid-stream; the fetch resumes from its last contiguous byte', async () => {
      // A slow reader: it takes ~1.5 MB and stops, holding the rest of the stream open.
      await page.evaluate((u) => {
        const probe = { held: 0, go: false, done: false, hash: '', size: 0, error: '' };
        (window as unknown as { __probe: typeof probe }).__probe = probe;
        void (async () => {
          try {
            const r = await fetch(u + '?tag=resume');
            const reader = r.body!.getReader();
            const parts: Uint8Array[] = [];
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parts.push(value);
              probe.held += value.length;
              while (probe.held > 1_500_000 && !probe.go) await new Promise((res) => setTimeout(res, 50));
            }
            const all = new Uint8Array(probe.held);
            let o = 0;
            for (const p of parts) { all.set(p, o); o += p.length; }
            probe.size = all.length;
            probe.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
          } catch (e) {
            probe.error = String(e);
          }
          probe.done = true;
        })();
      }, url);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __probe: { held: number } }).__probe.held), { timeout: 20_000 }).toBeGreaterThan(1_500_000);
      const before = (await page.evaluate(() => window.NP_AWSP!.stats())) as { stats: { resumedWelcomes: number; lost: number } };

      await stopRelay();
      // Three missed pongs: the client calls the connection lost and starts reconnecting.
      await expect.poll(async () => ((await page.evaluate(() => window.NP_AWSP!.status())).status), { timeout: 20_000 }).toBe('reconnecting');
      await page.waitForTimeout(1000);
      await startRelay();
      await expect.poll(async () => ((await page.evaluate(() => window.NP_AWSP!.status())).status), { timeout: 60_000, intervals: [250] }).toBe('connected');

      await page.evaluate(() => { (window as unknown as { __probe: { go: boolean } }).__probe.go = true; });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __probe: { done: boolean } }).__probe.done), { timeout: 60_000 }).toBe(true);
      const probe = await page.evaluate(() => (window as unknown as { __probe: { size: number; hash: string; error: string } }).__probe);
      expect(probe.error).toBe('');
      expect(probe).toMatchObject({ size: fixture.length, hash: sha256(fixture) });

      const after = (await page.evaluate(() => window.NP_AWSP!.stats())) as {
        stats: { resumedWelcomes: number; lost: number; resumes: Array<{ tag: string | null; request_start: number; held: number; from: number }> };
      };
      expect(after.stats.lost, 'the connection was lost').toBeGreaterThan(before.stats.lost);
      expect(after.stats.resumedWelcomes, 'the server accepted the resume token').toBeGreaterThan(before.stats.resumedWelcomes);
      const resumed = after.stats.resumes.filter((r) => r.tag === 'resume');
      console.log(`fixture ${fixture.length} bytes; resumed fetches: ${JSON.stringify(after.stats.resumes)}; connection lost ${after.stats.lost}x, resume token accepted ${after.stats.resumedWelcomes}x`);
      expect(resumed.length, JSON.stringify(after.stats.resumes)).toBeGreaterThanOrEqual(1);
      for (const r of resumed) {
        expect(r.from, 'resumed at a non-zero offset').toBeGreaterThan(0);
        expect(r.from, 'resumed at exactly the bytes already held').toBe(r.request_start + r.held);
      }
      expect(resumed[0]!.held).toBeGreaterThanOrEqual(1_500_000);
    });

    expect(errors, errors.join(' | ')).toEqual([]);
  });
});
