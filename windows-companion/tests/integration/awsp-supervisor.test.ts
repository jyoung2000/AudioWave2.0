/**
 * The companion's side of AWSP, against the real sidecar: the supervisor starts the built
 * `awsp-server` with a key it generated and keeps encrypted, receives the ticket and draws its QR
 * code, asks for a pairing code, and stops it cleanly. The protocol itself is tested in the crate
 * (`awsp-server/tests/awsp.rs`); this is the contract between the two processes.
 *
 * Skipped, with the reason, when the release binary has not been built on this machine.
 */
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AwspSupervisor } from '../../src/main/awsp.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import type { AwspStatus, NetworkKind } from '../../src/shared/ipc.js';

const BINARY = fileURLToPath(new URL(`../../awsp-server/target/release/awsp-server${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const built = existsSync(BINARY);

/** A reversible stand-in for DPAPI: the test checks the key is stored encrypted, not how. */
const secretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from([...Buffer.from(text, 'utf8')].reverse()),
  decryptString: (data: Buffer) => Buffer.from([...data].reverse()).toString('utf8'),
};

let dir = '';
let supervisor: AwspSupervisor | null = null;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function until(read: () => AwspStatus, test: (s: AwspStatus) => boolean, ms = 20_000): Promise<AwspStatus> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = read();
    if (test(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out; last status ${JSON.stringify(read())}`);
}

describe.skipIf(!built)(`the streaming server, supervised${built ? '' : ' (skipped: awsp-server not built — cargo build --release in windows-companion/awsp-server)'}`, () => {
  it('starts with a key it keeps encrypted, publishes the ticket and its QR, issues a pairing code, and stops', async () => {
    dir = mkdtempSync(join(tmpdir(), 'np-awsp-'));
    const store = new CompanionStore(openCompanionDb(join(dir, 'companion.sqlite')));
    const events: AwspStatus[] = [];
    // No relays and no DNS publishing: the test must not depend on the network.
    supervisor = new AwspSupervisor({
      store,
      secretBox,
      binary: BINARY,
      libraryDb: join(dir, 'companion.sqlite'),
      cacheDir: join(dir, 'cache'),
      serverName: 'Test companion',
      onStatus: (s) => events.push(s),
      log: () => undefined,
      relayMode: 'disabled',
    });

    const off = supervisor.getStatus();
    expect(off).toMatchObject({ enabled: false, running: false, devices: [] });

    await supervisor.setEnabled(true);
    const ready = await until(() => supervisor!.getStatus(), (s) => s.running && !!s.ticket && !!s.ticketQrSvg);
    expect(ready.endpointId).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.ticket).toMatch(/^endpoint[a-z2-7]+$/);
    expect(ready.ticketQrSvg).toContain('<svg');

    // The key was made once, and is stored only encrypted.
    const saved = store.get<string | null>('awspSecret', null);
    expect(saved).toBeTruthy();
    expect(saved).not.toContain(ready.endpointId!.slice(0, 16));

    supervisor.newPairingCode();
    const coded = await until(() => supervisor!.getStatus(), (s) => s.pairingCode !== null);
    expect(coded.pairingCode!.code).toMatch(/^\d{6}$/);

    // The same key gives the same identity after a restart: the ticket a device holds stays good.
    await supervisor.stop(false);
    await supervisor.setEnabled(true);
    const again = await until(() => supervisor!.getStatus(), (s) => s.running && !!s.endpointId);
    expect(again.endpointId).toBe(ready.endpointId);

    await supervisor.setEnabled(false);
    expect(supervisor.getStatus().running).toBe(false);
    expect(events.some((e) => e.running)).toBe(true);
    store.close();
  }, 60_000);
});

/**
 * A stand-in for the sidecar, speaking its JSON lines: ready once it has its config, gone on
 * `shutdown`. Lets the supervisor's own decisions — which connections it streams on, and when a
 * device was last seen — be tested on any machine.
 */
class FakeSidecar extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const message = JSON.parse(line) as { cmd?: string };
        if (!message.cmd) this.say({ event: 'ready', endpoint_id: 'e'.repeat(64), ticket: 'endpointabc', relay_url: null });
        if (message.cmd === 'shutdown') setTimeout(() => this.exit(), 1);
      }
      done();
    },
  });
  say(event: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  exit(): void {
    this.emit('exit', 0);
  }
  kill(): boolean {
    this.exit();
    return true;
  }
}

describe('which connections it streams on, and when a device was last seen', () => {
  let store: CompanionStore;
  let sidecars: FakeSidecar[];
  let connection: NetworkKind;
  let clock: number;
  const spawnImpl = (() => {
    const child = new FakeSidecar();
    sidecars.push(child);
    return child;
  }) as unknown as typeof spawn;

  const make = () =>
    new AwspSupervisor({
      store,
      secretBox,
      binary: 'awsp-server.exe',
      libraryDb: ':memory:',
      cacheDir: join(dir, 'cache'),
      serverName: 'Test companion',
      onStatus: () => undefined,
      log: () => undefined,
      spawnImpl,
      probeNetwork: async () => connection,
      now: () => clock,
    });

  afterEach(() => store?.close());

  it('pauses on a metered connection when that is switched off, says why, and starts again when allowed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'np-awsp-net-'));
    store = new CompanionStore(openCompanionDb(join(dir, 'companion.sqlite')));
    sidecars = [];
    connection = 'unmetered';
    clock = Date.parse('2026-10-03T12:00:00Z');
    supervisor = make();
    expect(supervisor.getStatus().network).toEqual({ unmetered: true, metered: true, connection: 'unknown', blocked: null });
    await supervisor.setEnabled(true);
    await supervisor.checkNetwork();
    await until(() => supervisor!.getStatus(), (s) => s.running);

    await supervisor.setNetworks({ metered: false });
    expect(supervisor.getStatus().running).toBe(true);

    // The PC moves to a phone's hotspot.
    connection = 'metered';
    await supervisor.checkNetwork();
    const paused = supervisor.getStatus();
    expect(paused.running).toBe(false);
    expect(paused.network).toMatchObject({ connection: 'metered', metered: false });
    expect(paused.reason).toMatch(/^Paused: this PC is on a metered connection/);
    expect(paused.enabled).toBe(true);
    expect(sidecars).toHaveLength(1);

    // Allowed again: it starts by itself.
    await supervisor.setNetworks({ metered: true });
    await until(() => supervisor!.getStatus(), (s) => s.running);
    expect(sidecars).toHaveLength(2);
    expect(supervisor.getStatus().reason).toBeNull();

    // Wi-Fi and Ethernet switched off while on Ethernet: paused for that reason instead.
    connection = 'unmetered';
    await supervisor.setNetworks({ unmetered: false });
    await supervisor.checkNetwork();
    expect(supervisor.getStatus()).toMatchObject({ running: false, reason: expect.stringMatching(/Wi-Fi or Ethernet/) });
    // And it stays off across a restart of the companion, on that connection.
    await supervisor.stop();
    supervisor = make();
    supervisor.boot();
    await supervisor.checkNetwork();
    expect(supervisor.getStatus().running).toBe(false);
    expect(sidecars).toHaveLength(2);
  });

  it('records when each paired device was last seen, kept with the device', async () => {
    dir = mkdtempSync(join(tmpdir(), 'np-awsp-seen-'));
    store = new CompanionStore(openCompanionDb(join(dir, 'companion.sqlite')));
    sidecars = [];
    connection = 'unmetered';
    clock = Date.parse('2026-10-03T12:00:00Z');
    supervisor = make();
    await supervisor.setEnabled(true);
    await until(() => supervisor!.getStatus(), (s) => s.running);
    const sidecar = sidecars[0]!;
    sidecar.say({ event: 'paired', id: 'phone', name: 'Sam’s Phone', client_kind: 'android' });
    await until(() => supervisor!.getStatus(), (s) => s.devices.length === 1);
    expect(supervisor.getStatus().devices[0]!.lastSeenAt).toBe('2026-10-03T12:00:00.000Z');

    clock += 5 * 60_000;
    sidecar.say({ event: 'connection', peer: 'phone', type: 'direct', rtt_ms: 34 });
    await until(() => supervisor!.getStatus(), (s) => s.connections.length === 1);
    expect(supervisor.getStatus().devices[0]!.lastSeenAt).toBe('2026-10-03T12:05:00.000Z');
    expect(supervisor.getStatus().connections[0]).toEqual({ peer: 'phone', name: 'Sam’s Phone', type: 'direct', rttMs: 34 });

    clock += 30 * 60_000;
    sidecar.say({ event: 'disconnected', peer: 'phone' });
    await until(() => supervisor!.getStatus(), (s) => s.connections.length === 0);
    expect(supervisor.getStatus().devices[0]!.lastSeenAt).toBe('2026-10-03T12:35:00.000Z');
    // Kept encrypted with the device, so it is there after a restart.
    expect(make().devices()[0]!.lastSeenAt).toBe('2026-10-03T12:35:00.000Z');
  });
});
