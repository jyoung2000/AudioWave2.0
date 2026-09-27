/**
 * The AWSP streaming server, supervised (docs/AWSP.md).
 *
 * The server itself is a Rust sidecar (`awsp-server/`): it owns the iroh endpoint, the allowlist
 * check, the library lookups and the range serving. This file is what the companion owns around it:
 *
 * - **Secrets.** The endpoint's `SecretKey` and the allowlist of paired devices are kept here, in the
 *   companion's database, encrypted with the OS key store (DPAPI through Electron's `safeStorage`).
 *   The sidecar receives them on stdin at start and never writes them anywhere.
 * - **Lifecycle.** Started when streaming is on, stopped when it is off or the app quits, restarted
 *   after a crash (with a back-off) and after the network changes, so the endpoint rebinds rather
 *   than holding sockets on an interface that has gone.
 * - **What Settings shows.** The ticket and its QR code, the one-time pairing code, the paired
 *   devices with their tier caps, and each live connection with its type (direct / relay).
 *
 * The contract with the sidecar is JSON lines: one config line, then commands, on stdin; events on
 * stdout; logs on stderr.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import QRCode from 'qrcode';
import type { AwspDevice, AwspStatus, AwspTier } from '../shared/ipc.js';
import type { SecretBox } from './helper.js';
import type { CompanionStore } from './store.js';

const KEY_SETTING = 'awspSecret';
const DEVICES_SETTING = 'awspDevices';
const OPTIONS_SETTING = 'awspOptions';
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface Options {
  enabled: boolean;
  /** Fixed UDP port for direct connections; null lets the OS choose. */
  port: number | null;
}

export interface AwspSupervisorOptions {
  store: CompanionStore;
  secretBox: SecretBox;
  /** The sidecar binary; null when it was not built or not packaged. */
  binary: string | null;
  libraryDb: string;
  cacheDir: string;
  serverName: string;
  onStatus: (status: AwspStatus) => void;
  log: (line: string) => void;
  /** n0's public relays by default; `disabled` keeps a test off the network. */
  relayMode?: 'default' | 'disabled';
  /** The FFmpeg the helper resolved (possibly one it set up itself), passed as AWSP_FFMPEG. */
  ffmpegPath?: () => string | null;
}

/** Where the sidecar lives: beside the app when packaged, in the crate's target folder in a checkout. */
export function findAwspBinary(appRoot: string, resourcesPath: string | null): string | null {
  const name = process.platform === 'win32' ? 'awsp-server.exe' : 'awsp-server';
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, name)] : []),
    join(appRoot, 'awsp-server', 'target', 'release', name),
    join(appRoot, 'awsp-server', 'target', 'debug', name),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export class AwspSupervisor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private netTimer: ReturnType<typeof setInterval> | null = null;
  private netSignature = '';
  private status: AwspStatus;

  constructor(private readonly options: AwspSupervisorOptions) {
    this.status = {
      enabled: this.readOptions().enabled,
      running: false,
      reason: options.binary ? null : 'The streaming server was not built with this copy of the companion.',
      endpointId: null,
      ticket: null,
      ticketQrSvg: null,
      relayUrl: null,
      pairingCode: null,
      devices: this.devices(),
      connections: [],
      port: this.readOptions().port,
    };
  }

  /* ------------------------------------------------------------- secrets */

  private readSecret<T>(setting: string, fallback: T): T {
    const { store, secretBox } = this.options;
    const saved = store.get<string | null>(setting, null);
    if (!saved || !secretBox.isEncryptionAvailable()) return fallback;
    try {
      return JSON.parse(secretBox.decryptString(Buffer.from(saved, 'base64'))) as T;
    } catch {
      return fallback;
    }
  }

  private writeSecret(setting: string, value: unknown): void {
    const { store, secretBox } = this.options;
    store.set(setting, secretBox.encryptString(JSON.stringify(value)).toString('base64'), new Date().toISOString());
  }

  /** The endpoint's secret key, made once. Null when the OS key store cannot protect it. */
  private secretKeyHex(): string | null {
    if (!this.options.secretBox.isEncryptionAvailable()) return null;
    const existing = this.readSecret<string | null>(KEY_SETTING, null);
    if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
    const hex = randomBytes(32).toString('hex');
    this.writeSecret(KEY_SETTING, hex);
    return hex;
  }

  devices(): AwspDevice[] {
    return this.readSecret<AwspDevice[]>(DEVICES_SETTING, []);
  }

  private saveDevices(devices: AwspDevice[]): void {
    this.writeSecret(DEVICES_SETTING, devices);
    this.publish({ devices });
  }

  private readOptions(): Options {
    const saved = this.options.store.get<Partial<Options> | null>(OPTIONS_SETTING, null) ?? {};
    return { enabled: saved.enabled === true, port: typeof saved.port === 'number' ? saved.port : null };
  }

  private saveOptions(next: Options): void {
    this.options.store.set(OPTIONS_SETTING, next, new Date().toISOString());
  }

  /* ------------------------------------------------------------ lifecycle */

  getStatus(): AwspStatus {
    return this.status;
  }

  private publish(patch: Partial<AwspStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus(this.status);
  }

  async setEnabled(enabled: boolean): Promise<AwspStatus> {
    this.saveOptions({ ...this.readOptions(), enabled });
    this.publish({ enabled });
    if (enabled) this.start();
    else await this.stop();
    return this.status;
  }

  async setPort(port: number | null): Promise<AwspStatus> {
    this.saveOptions({ ...this.readOptions(), port });
    this.publish({ port });
    if (this.child) await this.restart();
    return this.status;
  }

  /** Called at start-up: streams if it was on last time. */
  boot(): void {
    if (this.readOptions().enabled) this.start();
    // A changed set of interfaces (Wi-Fi to Ethernet, a VPN, waking up) means rebinding.
    this.netSignature = this.networkSignature();
    this.netTimer = setInterval(() => {
      const next = this.networkSignature();
      if (next !== this.netSignature) {
        this.netSignature = next;
        this.options.log('awsp: the network changed; rebinding');
        if (this.child) void this.restart();
      }
    }, 15_000);
    this.netTimer.unref?.();
  }

  /**
   * FFmpeg just became available. The sidecar reads it at start, so an idle sidecar is restarted
   * to pick it up; one with connected devices is left alone and picks it up on its next start.
   */
  toolsChanged(): void {
    if (this.child && !this.status.connections.length) void this.restart();
  }

  /** From Electron's powerMonitor: a machine that slept has new sockets to make. */
  onResume(): void {
    if (this.child) void this.restart();
  }

  private networkSignature(): string {
    const all = networkInterfaces();
    return Object.keys(all)
      .sort()
      .map((name) => `${name}:${(all[name] ?? []).filter((a) => !a.internal).map((a) => a.address).sort().join(',')}`)
      .join('|');
  }

  private start(): void {
    if (this.child || !this.options.binary) return;
    const secret = this.secretKeyHex();
    if (!secret) {
      this.publish({ running: false, reason: 'Windows could not protect the streaming key, so streaming is off.' });
      return;
    }
    this.stopping = false;
    // The sidecar transcodes with `AWSP_FFMPEG`, else whatever `ffmpeg` is on PATH. A copy the helper
    // set up itself is not on PATH, so it is named here.
    const ffmpeg = this.options.ffmpegPath?.() ?? null;
    const child = spawn(this.options.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(ffmpeg ? { AWSP_FFMPEG: ffmpeg } : {}) } });
    this.child = child;
    const config = {
      secret_key_hex: secret,
      library_db: this.options.libraryDb,
      cache_dir: this.options.cacheDir,
      server_name: this.options.serverName,
      allowlist: this.devices().map((d) => ({ id: d.id, name: d.name, tier_cap: d.tierCap, paired_at: d.pairedAt })),
      relay_mode: this.options.relayMode ?? 'default',
      relay_urls: [],
      relay_only: false,
      bind_port: this.readOptions().port,
      insecure_relay_tls: false,
    };
    child.stdin?.write(`${JSON.stringify(config)}\n`);
    createInterface({ input: child.stdout! }).on('line', (line) => this.onEvent(line));
    createInterface({ input: child.stderr! }).on('line', (line) => this.options.log(`awsp-server: ${line}`));
    child.on('exit', (code) => {
      this.child = null;
      this.publish({ running: false, connections: [], pairingCode: null });
      if (this.stopping) return;
      const wait = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!;
      this.restarts += 1;
      this.publish({ reason: `The streaming server stopped (exit ${code ?? 'signal'}); restarting in ${Math.round(wait / 1000)} s.` });
      this.restartTimer = setTimeout(() => this.start(), wait);
    });
  }

  private onEvent(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.log(`awsp-server said something that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    switch (event['event']) {
      case 'ready': {
        this.restarts = 0;
        const ticket = String(event['ticket'] ?? '');
        void QRCode.toString(ticket, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
          .then((svg) => this.publish({ ticketQrSvg: svg }))
          .catch(() => undefined);
        this.publish({ running: true, reason: null, endpointId: String(event['endpoint_id'] ?? ''), ticket, relayUrl: (event['relay_url'] as string | null) ?? null });
        break;
      }
      case 'pairing_code':
        this.publish({ pairingCode: { code: String(event['code']), expiresAt: String(event['expires_at']) } });
        break;
      case 'paired': {
        const id = String(event['id']);
        const others = this.devices().filter((d) => d.id !== id);
        const device: AwspDevice = { id, name: String(event['name'] ?? 'A device'), clientKind: event['client_kind'] === 'android' ? 'android' : 'pwa', tierCap: 'lossless', pairedAt: new Date().toISOString() };
        this.saveDevices([...others, device]);
        this.publish({ pairingCode: null });
        break;
      }
      case 'connection': {
        const peer = String(event['peer']);
        const type = event['type'] === 'direct' ? 'direct' : 'relay';
        const rttMs = typeof event['rtt_ms'] === 'number' ? event['rtt_ms'] : null;
        this.options.log(`awsp connection ${peer} type=${type} rtt=${rttMs ?? '?'}`);
        const name = this.devices().find((d) => d.id === peer)?.name ?? null;
        this.publish({ connections: [...this.status.connections.filter((c) => c.peer !== peer), { peer, name, type, rttMs }] });
        break;
      }
      case 'disconnected':
        this.publish({ connections: this.status.connections.filter((c) => c.peer !== String(event['peer'])) });
        break;
      case 'error':
        this.options.log(`awsp-server error: ${String(event['message'])}`);
        this.publish({ reason: String(event['message']) });
        break;
      default:
        break;
    }
  }

  private send(command: Record<string, unknown>): boolean {
    if (!this.child?.stdin) return false;
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  newPairingCode(): AwspStatus {
    if (!this.send({ cmd: 'new_pairing_code' })) this.publish({ reason: 'Turn streaming on to pair a device.' });
    return this.status;
  }

  revoke(id: string): AwspStatus {
    this.saveDevices(this.devices().filter((d) => d.id !== id));
    this.send({ cmd: 'revoke', id });
    return this.status;
  }

  setTierCap(id: string, tier: AwspTier): AwspStatus {
    this.saveDevices(this.devices().map((d) => (d.id === id ? { ...d, tierCap: tier } : d)));
    this.send({ cmd: 'set_tier_cap', id, tier });
    return this.status;
  }

  private async restart(): Promise<void> {
    await this.stop(false);
    this.start();
  }

  async stop(forGood = true): Promise<void> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (forGood && this.netTimer) {
      clearInterval(this.netTimer);
      this.netTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    this.send({ cmd: 'shutdown' });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([exited, timeout]);
    if (this.child === child) child.kill();
    this.child = null;
  }
}
