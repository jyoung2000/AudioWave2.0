import type { GroupSyncGrade, ProviderAppConfigInput, ProviderAppConfigView, ProviderCapabilities, ProviderDescriptor, ProviderHealth, TrackRef } from '@now-playing/contracts';
import { DomainError, maskSecretHint } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { Sealer } from '../crypto/seal.js';
import type { ProviderAppConfigRow, ProvidersRepository } from '../db/repositories/providers.js';
import type { Clock } from '../deps.js';
import type { Logger } from 'pino';
import { EMPTY_RUNTIME_CONFIG, type ProviderAdapter, type ProviderRuntimeConfig } from './adapter.js';
import type { RateLimitManager } from './rate-limit-manager.js';

/** Provider adapters, their application-level configuration (secrets sealed at rest) and live health. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly runtime = new Map<string, ProviderRuntimeConfig>();

  constructor(
    private readonly repo: ProvidersRepository,
    private readonly sealer: Sealer,
    private readonly rateLimiter: RateLimitManager,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
    const stored = this.repo.getConfig(adapter.id);
    const config = stored ? this.toRuntime(stored) : { ...EMPTY_RUNTIME_CONFIG, enabled: this.defaultEnabled(adapter.id) };
    this.runtime.set(adapter.id, config);
    adapter.configure(config);
  }

  private defaultEnabled(id: string): boolean {
    return id !== 'external-tool';
  }

  private toRuntime(row: ProviderAppConfigRow): ProviderRuntimeConfig {
    const open = (sealed: string | null): string | null => {
      if (!sealed) return null;
      try {
        return this.sealer.open(sealed, `provider:${row.provider}`);
      } catch (err) {
        this.log.error({ module: 'providers', provider: row.provider, err: err instanceof Error ? err.message : String(err) }, 'could not unseal provider secret (installation key changed?)');
        return null;
      }
    };
    return { enabled: row.enabled === 1, clientId: row.client_id, clientSecret: open(row.client_secret_sealed), apiKey: open(row.api_key_sealed), applicationId: row.application_id, redirectUri: row.redirect_uri, contactEmail: row.contact_email, extra: JSON.parse(row.extra) as Record<string, string> };
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  get(id: string): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new DomainError('not-found', `Unknown provider ${id}`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  runtimeConfig(id: string): ProviderRuntimeConfig {
    return this.runtime.get(id) ?? EMPTY_RUNTIME_CONFIG;
  }

  isEnabled(id: string): boolean {
    return this.runtime.get(id)?.enabled ?? false;
  }

  isConfigured(id: string): boolean {
    const adapter = this.adapters.get(id);
    if (!adapter) return false;
    return this.missing(id).length === 0;
  }

  missing(id: string): string[] {
    const adapter = this.get(id);
    const cfg = this.runtimeConfig(id);
    return adapter.requiredConfig().filter((field) => {
      const value = (cfg as unknown as Record<string, unknown>)[field] ?? cfg.extra[field];
      return value === null || value === undefined || value === '';
    });
  }

  enabledAdapters(): ProviderAdapter[] {
    return [...this.adapters.values()].filter((a) => this.isEnabled(a.id));
  }

  /** Adapters that can answer a search right now (enabled and configured). */
  searchable(): ProviderAdapter[] {
    return this.enabledAdapters().filter((a) => this.isConfigured(a.id) && a.capabilities().search !== 'unsupported');
  }

  descriptor(id: string): ProviderDescriptor {
    const adapter = this.get(id);
    return { ...adapter.descriptor(), capabilities: this.effectiveCapabilities(id), enabled: this.isEnabled(id), configured: this.isConfigured(id) };
  }

  descriptors(): ProviderDescriptor[] {
    return this.ids().map((id) => this.descriptor(id));
  }

  /** Capabilities with configuration state folded in: an unconfigured provider reports requires_auth, a disabled one unsupported. */
  effectiveCapabilities(id: string): ProviderCapabilities {
    const adapter = this.get(id);
    const caps = adapter.capabilities();
    if (!this.isEnabled(id)) {
      const out = { ...caps, reason: 'Disabled by the administrator' } as ProviderCapabilities;
      for (const key of ['metadata', 'search', 'preview', 'playback', 'importLikes', 'importPlaylists', 'creatorDownload', 'userOwnedDownload', 'eq'] as const) out[key] = 'unsupported';
      return out;
    }
    const missing = this.missing(id);
    if (missing.length) {
      const out = { ...caps, reason: `Not configured: ${missing.join(', ')} missing (Admin → Providers)` } as ProviderCapabilities;
      for (const key of ['metadata', 'search', 'preview', 'playback', 'importLikes', 'importPlaylists'] as const) if (out[key] === 'available') out[key] = 'requires_auth';
      return out;
    }
    return caps;
  }

  async health(id: string): Promise<ProviderHealth> {
    const adapter = this.get(id);
    const usage = this.rateLimiter.usage(id);
    const checkedAt = new Date(this.clock.now()).toISOString();
    if (!this.isEnabled(id)) return { provider: id, status: 'disabled', circuit: 'closed', checkedAt };
    if (!this.isConfigured(id)) return { provider: id, status: 'unconfigured', circuit: 'closed', checkedAt, lastError: `Missing ${this.missing(id).join(', ')}` };
    let base: ProviderHealth;
    try {
      base = await adapter.health();
    } catch (err) {
      base = { provider: id, status: 'down', circuit: 'closed', checkedAt, lastError: err instanceof Error ? err.message : String(err) };
    }
    const status: ProviderHealth['status'] = usage.circuit === 'open' ? 'down' : usage.circuit === 'half-open' || usage.pausedUntil !== null ? 'degraded' : base.status;
    return { ...base, status, circuit: usage.circuit, ...(usage.latencyMs !== null ? { latencyMs: usage.latencyMs } : {}), ...(usage.budget.perDay !== null ? { quota: { used: usage.budget.usedDay, budget: usage.budget.perDay, unit: 'requests' } } : {}), ...(usage.lastError ? { lastError: usage.lastError } : {}), checkedAt };
  }

  async healthAll(): Promise<ProviderHealth[]> {
    return Promise.all(this.ids().map((id) => this.health(id)));
  }

  configView(id: string): ProviderAppConfigView {
    const adapter = this.get(id);
    const row = this.repo.getConfig(id);
    const cfg = this.runtimeConfig(id);
    const view: ProviderAppConfigView = { provider: adapter.id, enabled: cfg.enabled, configured: this.isConfigured(id), missing: this.missing(id) };
    if (cfg.clientId) view.clientId = cfg.clientId;
    if (cfg.clientSecret) view.clientSecretHint = maskSecretHint(cfg.clientSecret);
    if (cfg.apiKey) view.apiKeyHint = maskSecretHint(cfg.apiKey);
    if (cfg.applicationId) view.applicationId = cfg.applicationId;
    if (cfg.redirectUri) view.redirectUri = cfg.redirectUri;
    if (cfg.contactEmail) view.contactEmail = cfg.contactEmail;
    if (row) view.updatedAt = row.updated_at;
    return view;
  }

  /** Admin writes credentials once; secrets are sealed with the installation key and never returned. */
  putConfig(id: string, input: Omit<ProviderAppConfigInput, 'provider'>, meta: RequestMeta, actor: { id: string; displayName: string }): ProviderAppConfigView {
    this.get(id);
    const previous = this.runtimeConfig(id);
    const next: ProviderRuntimeConfig = {
      enabled: input.enabled ?? previous.enabled,
      clientId: input.clientId !== undefined ? input.clientId || null : previous.clientId,
      clientSecret: input.clientSecret !== undefined ? input.clientSecret || null : previous.clientSecret,
      apiKey: input.apiKey !== undefined ? input.apiKey || null : previous.apiKey,
      applicationId: input.applicationId !== undefined ? input.applicationId || null : previous.applicationId,
      redirectUri: input.redirectUri !== undefined ? input.redirectUri || null : previous.redirectUri,
      contactEmail: input.contactEmail !== undefined ? input.contactEmail || null : previous.contactEmail,
      extra: input.extra !== undefined ? { ...previous.extra, ...input.extra } : previous.extra,
    };
    const now = new Date(this.clock.now()).toISOString();
    this.repo.putConfig({ provider: id, enabled: next.enabled ? 1 : 0, client_id: next.clientId, client_secret_sealed: next.clientSecret ? this.sealer.seal(next.clientSecret, `provider:${id}`) : null, api_key_sealed: next.apiKey ? this.sealer.seal(next.apiKey, `provider:${id}`) : null, application_id: next.applicationId, redirect_uri: next.redirectUri, contact_email: next.contactEmail, extra: JSON.stringify(next.extra), updated_at: now });
    this.runtime.set(id, next);
    this.get(id).configure(next);
    this.rateLimiter.reset(id);
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'provider.config', outcome: 'success', target: { kind: 'provider', id }, ip: meta.ip, correlationId: meta.correlationId, details: { enabled: next.enabled, secretChanged: input.clientSecret !== undefined || input.apiKey !== undefined } });
    return this.configView(id);
  }

  async test(id: string): Promise<{ ok: boolean; latencyMs: number | null; message: string }> {
    if (!this.isEnabled(id)) return { ok: false, latencyMs: null, message: 'Provider is disabled' };
    const missing = this.missing(id);
    if (missing.length) return { ok: false, latencyMs: null, message: `Missing configuration: ${missing.join(', ')}` };
    try {
      return await this.rateLimiter.run(id, 'P0', () => this.get(id).test(), { timeoutMs: 15_000 });
    } catch (err) {
      return { ok: false, latencyMs: null, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Sync grade for a queued track, from the provider's reviewed capability plus the locator kind. */
  syncGradeFor(track: TrackRef): { grade: GroupSyncGrade; reason: string | null } {
    const hubHosted = track.locators.some((l) => l.kind === 'hub-blob');
    if (hubHosted || track.provider === 'hub' || track.provider === 'public-domain') return { grade: 'exact', reason: null };
    const adapter = this.adapters.get(track.provider);
    if (!adapter) return { grade: 'unsupported', reason: `Unknown provider ${track.provider}` };
    const grade = adapter.capabilities().groupSync;
    const reasons: Record<GroupSyncGrade, string | null> = { exact: null, near: 'Same representation for everyone; minor timing differences possible', best_effort: `${adapter.descriptor().displayName} streams cannot be seeked identically on every device`, unsupported: `${adapter.descriptor().displayName} playback cannot be aligned across listeners` };
    return { grade, reason: reasons[grade] };
  }

  usage(): Array<{ provider: string; health: Promise<ProviderHealth>; usage: ReturnType<RateLimitManager['usage']> }> {
    return this.ids().map((id) => ({ provider: id, health: this.health(id), usage: this.rateLimiter.usage(id) }));
  }
}
