import type { NetworkConfig } from '@now-playing/contracts';
import { ipInCidr, truncateIp } from '@now-playing/domain';
import { networkInterfaces } from 'node:os';
import type { BindMode, HubConfig, IpLoggingMode } from '../config.js';
import { parseCidrList, parsePublicEndpoint } from '../config.js';
import type { SettingsRepository } from '../db/repositories/settings.js';
import { hmacHex } from '../util.js';

export interface NetworkSettings {
  bindMode: BindMode;
  bindAddress: string | null;
  publicEndpoint: string | null;
  trustedProxyCidrs: string[];
  ipLogging: { mode: IpLoggingMode; retentionDays: number };
}

export const NETWORK_SETTINGS_KEY = 'network';

/**
 * Bind mode, public endpoint, trusted proxies and IP display policy. Persisted settings win over environment defaults;
 * the address the process actually bound to is remembered so `restartRequired` is honest.
 */
export class NetworkService {
  private settings: NetworkSettings;
  private readonly runtime: { bindMode: BindMode; bindAddress: string | null };

  constructor(
    private readonly config: HubConfig,
    private readonly repo: SettingsRepository,
    private readonly installKey: Uint8Array,
    private readonly now: () => string,
    private readonly allowedOriginsEnv: string[] = [],
  ) {
    const stored = repo.get<Partial<NetworkSettings>>(NETWORK_SETTINGS_KEY);
    this.settings = {
      bindMode: stored?.bindMode ?? config.bindMode,
      bindAddress: stored?.bindAddress ?? config.bindAddress,
      publicEndpoint: stored?.publicEndpoint ?? config.publicEndpoint,
      trustedProxyCidrs: stored?.trustedProxyCidrs ?? config.trustedProxyCidrs,
      ipLogging: stored?.ipLogging ?? { mode: config.ipLogging, retentionDays: 7 },
    };
    this.runtime = { bindMode: this.settings.bindMode, bindAddress: this.settings.bindAddress };
  }

  get current(): NetworkSettings {
    return this.settings;
  }

  /** The address the process should bind to. Non-loopback only in lan/remote mode and only once setup is complete. */
  bindAddressFor(setupComplete: boolean): string {
    if (this.settings.bindMode === 'localhost' || !setupComplete) return '127.0.0.1';
    return this.settings.bindAddress ?? '0.0.0.0';
  }

  isTrustedProxy(address: string): boolean {
    const ip = address.replace(/^::ffff:/, '');
    return this.settings.trustedProxyCidrs.some((cidr) => ipInCidr(ip, cidr));
  }

  /** Privacy-minimised IP for logs/audit: truncated (default), keyed hash or full. */
  ipDisplay(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const clean = ip.replace(/^::ffff:/, '');
    switch (this.settings.ipLogging.mode) {
      case 'full':
        return clean;
      case 'hashed':
        return `h:${hmacHex(this.installKey, `ip:${clean}`).slice(0, 16)}`;
      default:
        return truncateIp(clean);
    }
  }

  publicEndpoint(): string | null {
    return this.settings.publicEndpoint;
  }

  /** Reachable base URL for links: the public endpoint, else a LAN address in lan mode, else null (localhost-only). */
  reachableBaseUrl(): { url: string | null; reachable: boolean; warning: string | null } {
    if (this.settings.publicEndpoint) return { url: this.settings.publicEndpoint, reachable: true, warning: null };
    if (this.settings.bindMode === 'lan') {
      const lan = this.lanAddress();
      if (lan) return { url: `http://${lan}:${this.config.port}`, reachable: true, warning: 'This link works only on your local network (no public endpoint is configured).' };
    }
    return { url: `http://localhost:${this.config.port}`, reachable: false, warning: 'The hub is reachable only on this machine; set a public endpoint (Admin → Network) to share links with others.' };
  }

  lanAddress(): string | null {
    if (this.settings.bindAddress && this.settings.bindAddress !== '0.0.0.0' && this.settings.bindAddress !== '::') return this.settings.bindAddress;
    for (const list of Object.values(networkInterfaces())) {
      for (const iface of list ?? []) if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
    return null;
  }

  codeOnlyPairingAvailable(): boolean {
    return this.settings.bindMode !== 'localhost' && this.settings.publicEndpoint !== null;
  }

  /** Origins allowed for cross-origin API calls (bearer only; cookies never cross origins). */
  allowedOrigins(): string[] {
    const out = new Set<string>(this.allowedOriginsEnv);
    if (this.settings.publicEndpoint) out.add(new URL(this.settings.publicEndpoint).origin);
    return [...out];
  }

  restartRequired(): boolean {
    return this.runtime.bindMode !== this.settings.bindMode || (this.runtime.bindAddress ?? null) !== (this.settings.bindAddress ?? null);
  }

  warnings(): string[] {
    const w: string[] = [];
    if (this.settings.bindMode === 'remote' && !this.settings.publicEndpoint) w.push('Remote mode without a public endpoint: QR codes and share links cannot include a reachable address.');
    if (this.settings.bindMode === 'remote' && !this.settings.trustedProxyCidrs.length) w.push('Remote mode without trusted proxy CIDRs: client IPs will all appear as the proxy address.');
    if (this.settings.bindMode === 'lan' && !this.settings.publicEndpoint?.startsWith('https://')) w.push('LAN mode without TLS transmits the admin session in clear on your network.');
    if (this.settings.ipLogging.mode === 'full') w.push(`Full IP addresses are stored for ${this.settings.ipLogging.retentionDays} days.`);
    if (this.restartRequired()) w.push('Bind settings changed: restart the container to apply them.');
    return w;
  }

  toConfig(): NetworkConfig {
    return {
      bindMode: this.settings.bindMode,
      bindAddress: this.settings.bindAddress ?? (this.settings.bindMode === 'localhost' ? '127.0.0.1' : '0.0.0.0'),
      port: this.config.port,
      publicEndpoint: this.settings.publicEndpoint,
      trustedProxyCidrs: this.settings.trustedProxyCidrs,
      ipLogging: this.settings.ipLogging,
      tlsTerminatedByProxy: this.settings.publicEndpoint?.startsWith('https://') ?? false,
      restartRequired: this.restartRequired(),
      warnings: this.warnings(),
    };
  }

  update(patch: { bindMode?: BindMode; publicEndpoint?: string | null; trustedProxyCidrs?: string[]; ipLogging?: { mode: IpLoggingMode; retentionDays: number }; bindAddress?: string | null }): NetworkConfig {
    const next: NetworkSettings = {
      bindMode: patch.bindMode ?? this.settings.bindMode,
      bindAddress: patch.bindAddress !== undefined ? patch.bindAddress : this.settings.bindAddress,
      publicEndpoint: patch.publicEndpoint !== undefined ? parsePublicEndpoint(patch.publicEndpoint) : this.settings.publicEndpoint,
      trustedProxyCidrs: patch.trustedProxyCidrs !== undefined ? parseCidrList(patch.trustedProxyCidrs.join(',')) : this.settings.trustedProxyCidrs,
      ipLogging: patch.ipLogging ?? this.settings.ipLogging,
    };
    this.settings = next;
    this.repo.set(NETWORK_SETTINGS_KEY, next, this.now());
    return this.toConfig();
  }
}
