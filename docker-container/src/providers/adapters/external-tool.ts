import { existsSync } from 'node:fs';
import type { ProviderCapabilities, ProviderDescriptor, SearchResult } from '@now-playing/contracts';
import { hostMatches, validateOutboundUrl } from '@now-playing/domain';
import type { AuthorizedDownload, DownloadContext, ProviderTestResult } from '../adapter.js';
import { BaseAdapter, caps, REVIEWED_AT, result } from './base.js';

/**
 * Optional bridge to an administrator-installed command-line media tool. Off by default. The hub does not ship any
 * such tool, never passes cookies or credentials to it, restricts it to allowlisted hosts, and only runs it for
 * downloads the requesting user has explicitly attributed to a rights basis (own content / licensed / public domain).
 * Configuration (Admin → Providers → External tool): `extra.command` — a template such as
 * `/usr/local/bin/mytool --no-playlist -o {output} {url}` — and `extra.allowedHosts` — comma-separated hostnames.
 */
export class ExternalToolAdapter extends BaseAdapter {
  readonly id = 'external-tool';

  descriptor(): Omit<ProviderDescriptor, 'enabled' | 'configured' | 'capabilities'> {
    return { provider: this.id, displayName: 'External media tool', role: 'tool', authType: 'local', authScopes: [], groupCompatible: false, discordCompatible: false, reviewedAt: REVIEWED_AT, limitations: ['Disabled by default; the administrator must install a tool and allowlist hosts', 'Only for content you own or are licensed to download; the request records the rights basis', 'No cookies, credentials or DRM circumvention; the tool runs without a shell and with a timeout'] };
  }

  capabilities(): ProviderCapabilities {
    return caps({ metadata: 'restricted', creatorDownload: 'restricted', userOwnedDownload: 'restricted', groupSync: 'unsupported', reason: 'Only for allowlisted hosts and content you have rights to; enabled by the administrator' });
  }

  override requiredConfig(): readonly string[] {
    return ['command', 'allowedHosts'];
  }

  override allowedHosts(): readonly string[] {
    return (this.config.extra['allowedHosts'] ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  commandTemplate(): string[] {
    return (this.config.extra['command'] ?? '').split(/\s+/).filter(Boolean);
  }

  timeoutMs(): number {
    const n = Number(this.config.extra['timeoutSeconds'] ?? 600);
    return (Number.isFinite(n) && n > 0 ? n : 600) * 1000;
  }

  override async test(): Promise<ProviderTestResult> {
    const [binary] = this.commandTemplate();
    if (!binary) return { ok: false, latencyMs: null, message: 'No command configured' };
    if (!existsSync(binary)) return { ok: false, latencyMs: null, message: `Binary not found: ${binary}` };
    if (!this.allowedHosts().length) return { ok: false, latencyMs: null, message: 'No allowed hosts configured' };
    return { ok: true, latencyMs: null, message: `Tool present; ${this.allowedHosts().length} host(s) allowlisted` };
  }

  private allowed(url: string): URL | null {
    const check = validateOutboundUrl(url, { allowedHosts: this.allowedHosts(), allowedSchemes: ['https:'] });
    if (!check.ok || !check.url) return null;
    return this.allowedHosts().some((h) => hostMatches(check.url!.hostname, h)) ? check.url : null;
  }

  override async resolve(urlOrId: string): Promise<SearchResult | null> {
    const u = this.allowed(urlOrId.trim());
    if (!u) return null;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname);
    return result({ provider: this.id, kind: 'track', providerId: u.toString(), title: slug || u.hostname, artistName: u.hostname, canonicalUrl: u.toString(), capabilities: this.capabilities(), attribution: `Source: ${u.hostname}`, accessState: 'restricted' });
  }

  override async getAuthorizedDownload(id: string, context: DownloadContext): Promise<AuthorizedDownload | null> {
    const u = this.allowed(id);
    if (!u) return null;
    if (!['user-owned', 'licensed', 'public-domain', 'purchased-export', 'creator-download'].includes(context.basis)) return null;
    const slug = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? 'download');
    return { kind: 'external-tool', url: u.toString(), filename: slug || 'download', basis: context.basis };
  }
}
