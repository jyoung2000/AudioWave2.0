/**
 * The companion's side of AWSP, against the real sidecar: the supervisor starts the built
 * `awsp-server` with a key it generated and keeps encrypted, receives the ticket and draws its QR
 * code, asks for a pairing code, and stops it cleanly. The protocol itself is tested in the crate
 * (`awsp-server/tests/awsp.rs`); this is the contract between the two processes.
 *
 * Skipped, with the reason, when the release binary has not been built on this machine.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AwspSupervisor } from '../../src/main/awsp.js';
import { CompanionStore, openCompanionDb } from '../../src/main/store.js';
import type { AwspStatus } from '../../src/shared/ipc.js';

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
