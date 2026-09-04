/**
 * Per-user provider accounts.
 *
 * The administrator configures the *application* credentials once (client id and secret, stored
 * sealed and never returned). Each person then connects their *own* account through OAuth 2.0
 * authorization-code with PKCE. Their access and refresh tokens are sealed with the installation
 * key, refreshed server-side, and never sent to any client — the player asks the hub to act on its
 * behalf rather than holding a token itself.
 *
 * Disconnecting deletes the tokens outright rather than marking a row inactive.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ProviderAccount, UserPlatformSync } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { Sealer } from '../crypto/seal.js';
import type { AccountRecord, ProvidersRepository } from '../db/repositories/providers.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import { isOAuthCapable, type AuthorizedAccount } from './adapter.js';
import type { ProviderRegistry } from './registry.js';
import type { RateLimitManager } from './rate-limit-manager.js';

const STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before expiry so a request never races the clock. */
const REFRESH_SKEW_MS = 60_000;

export interface ConnectStart {
  authorizationUrl: string;
  state: string;
  scopes: string[];
}

export interface CallbackResult {
  provider: string;
  displayName: string | null;
  returnTo: string | null;
  ownerUserId: string;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export class AccountsService {
  constructor(
    private readonly repo: ProvidersRepository,
    private readonly registry: ProviderRegistry,
    private readonly rateLimiter: RateLimitManager,
    private readonly sealer: Sealer,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private redirectUri(provider: string, baseUrl: string): string {
    const configured = this.registry.runtimeConfig(provider).redirectUri;
    return configured ?? `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(provider)}/callback`;
  }

  /** What the caller may connect, and why not when they cannot. */
  available(): Array<{ provider: string; configured: boolean; reason: string | null }> {
    return this.registry.ids().map((provider) => {
      const adapter = this.registry.get(provider);
      if (!isOAuthCapable(adapter)) return { provider, configured: false, reason: 'This provider does not support connecting a personal account' };
      if (!this.registry.isEnabled(provider)) return { provider, configured: false, reason: 'Disabled by the administrator' };
      const missing = this.registry.missing(provider);
      if (missing.length) return { provider, configured: false, reason: `The administrator has not set ${missing.join(', ')} for this provider yet` };
      return { provider, configured: true, reason: null };
    });
  }

  list(ownerUserId: string): ProviderAccount[] {
    return this.repo.listAccounts(ownerUserId).map((a) => this.publicView(a));
  }

  private publicView(account: AccountRecord): ProviderAccount {
    const { accessTokenSealed: _a, refreshTokenSealed: _r, ...rest } = account;
    return rest;
  }

  startConnect(provider: string, ownerUserId: string, ownerDeviceId: string | null, baseUrl: string, returnTo: string | null): ConnectStart {
    const adapter = this.registry.get(provider);
    if (!isOAuthCapable(adapter)) throw new DomainError('unsupported', `${provider} does not support connecting a personal account`);
    if (!this.registry.isEnabled(provider)) throw new DomainError('forbidden', `${provider} is disabled`);
    const missing = this.registry.missing(provider);
    if (missing.length) throw new DomainError('setup-required', `The administrator must set ${missing.join(', ')} for ${provider} first`);

    const { verifier, challenge } = pkcePair();
    const state = randomBytes(32).toString('base64url');
    const redirectUri = this.redirectUri(provider, baseUrl);
    this.repo.createOAuthState({
      state,
      provider,
      owner_user_id: ownerUserId,
      owner_device_id: ownerDeviceId,
      code_verifier_sealed: this.sealer.seal(verifier, `oauth:${provider}`),
      return_to: returnTo,
      created_at: this.nowIso(),
      expires_at: new Date(this.clock.now() + STATE_TTL_MS).toISOString(),
    });
    this.metrics.increment(`accounts.${provider}.connect_started`);
    return { authorizationUrl: adapter.oauth.authorizationUrl({ redirectUri, state, codeChallenge: challenge }), state, scopes: [...adapter.oauth.scopes] };
  }

  /** Exchange the authorization code. Single use: the state row is consumed whether or not it succeeds. */
  async completeConnect(provider: string, code: string | undefined, state: string, baseUrl: string, meta: RequestMeta): Promise<CallbackResult> {
    const row = this.repo.takeOAuthState(state);
    if (!row) throw new DomainError('forbidden', 'This authorization link has already been used or has expired');
    if (row.provider !== provider) throw new DomainError('forbidden', 'Authorization state does not match this provider');
    if (Date.parse(row.expires_at) <= this.clock.now()) throw new DomainError('forbidden', 'Authorization timed out; start again');
    if (!code) throw new DomainError('validation', 'The provider did not return an authorization code');

    const adapter = this.registry.get(provider);
    if (!isOAuthCapable(adapter)) throw new DomainError('unsupported', `${provider} does not support connecting a personal account`);
    const verifier = row.code_verifier_sealed ? this.sealer.open(row.code_verifier_sealed, `oauth:${provider}`) : '';

    const tokens = await this.rateLimiter.run(provider, 'P0', () => adapter.oauth.exchangeCode({ code, redirectUri: this.redirectUri(provider, baseUrl), codeVerifier: verifier }), { timeoutMs: 15_000 });
    const profile = await this.rateLimiter.run(provider, 'P0', () => adapter.oauth.profile(tokens.accessToken), { timeoutMs: 15_000 }).catch(() => ({ externalUserId: 'unknown', displayName: null }));

    const now = this.nowIso();
    const existing = this.repo.findAccount(provider, row.owner_user_id);
    const account: AccountRecord = {
      id: existing?.id ?? uuidv7(this.clock.now()),
      schemaVersion: 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      provider,
      ownerUserId: row.owner_user_id,
      ownerDeviceId: row.owner_device_id,
      externalUserId: profile.externalUserId,
      displayName: profile.displayName,
      scopes: tokens.scopes,
      status: 'connected',
      expiresAt: tokens.expiresAt,
      lastSyncAt: existing?.lastSyncAt ?? null,
      lastError: null,
      importCursor: existing?.importCursor ?? null,
      tokenLast4: tokens.accessToken.slice(-4),
      accessTokenSealed: this.sealer.seal(tokens.accessToken, `token:${provider}:${row.owner_user_id}`),
      refreshTokenSealed: tokens.refreshToken ? this.sealer.seal(tokens.refreshToken, `token:${provider}:${row.owner_user_id}`) : null,
    };
    this.repo.upsertAccount(account);
    this.metrics.increment(`accounts.${provider}.connected`);
    this.audit.record({ actor: { kind: 'device', id: row.owner_device_id ?? row.owner_user_id, displayName: profile.displayName ?? 'device' }, action: 'account.connect', outcome: 'success', target: { kind: 'provider', id: provider }, ip: meta.ip, correlationId: meta.correlationId, details: { scopes: tokens.scopes.join(' ') } });
    return { provider, displayName: profile.displayName, returnTo: row.return_to, ownerUserId: row.owner_user_id };
  }

  disconnect(provider: string, ownerUserId: string, meta: RequestMeta, actorDisplayName: string): void {
    const existing = this.repo.findAccount(provider, ownerUserId);
    if (!existing) throw new DomainError('not-found', 'No connected account for this provider');
    this.repo.deleteAccount(provider, ownerUserId);
    this.repo.putPlatformSync({ userId: ownerUserId, provider, lastSyncAt: null, cursor: null, snapshot: null, etag: null, status: 'idle', lastError: null });
    this.metrics.increment(`accounts.${provider}.disconnected`);
    this.audit.record({ actor: { kind: 'device', id: ownerUserId, displayName: actorDisplayName }, action: 'account.disconnect', outcome: 'success', target: { kind: 'provider', id: provider }, ip: meta.ip, correlationId: meta.correlationId });
  }

  /**
   * Decrypt an account's tokens for one call, refreshing first when they are about to expire.
   * Nothing else in the hub is allowed to touch sealed token material.
   */
  async authorize(provider: string, ownerUserId: string): Promise<AuthorizedAccount> {
    const record = this.repo.findAccount(provider, ownerUserId);
    if (!record) throw new DomainError('not-found', `No ${provider} account is connected`);
    const open = (sealed: string | null): string | null => {
      if (!sealed) return null;
      try {
        return this.sealer.open(sealed, `token:${provider}:${ownerUserId}`);
      } catch {
        return null;
      }
    };
    let accessToken = open(record.accessTokenSealed);
    const refreshToken = open(record.refreshTokenSealed);
    const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : null;
    const needsRefresh = !accessToken || (expiresAt !== null && expiresAt - REFRESH_SKEW_MS <= this.clock.now());

    if (needsRefresh) {
      const adapter = this.registry.get(provider);
      const refreshed = await this.rateLimiter.run(provider, 'P0', () => adapter.refreshCredentials({ ...this.publicView(record), accessToken, refreshToken }), { timeoutMs: 15_000 });
      const now = this.nowIso();
      if (refreshed.status !== 'connected' || !refreshed.accessToken) {
        this.repo.upsertAccount({ ...record, status: refreshed.status, lastError: refreshed.error ?? 'Could not refresh the access token', updatedAt: now });
        this.metrics.increment(`accounts.${provider}.refresh_failed`);
        throw new DomainError('unauthenticated', `Your ${provider} connection needs to be renewed: ${refreshed.error ?? 'the token expired'}`);
      }
      accessToken = refreshed.accessToken;
      this.repo.upsertAccount({
        ...record,
        status: 'connected',
        lastError: null,
        updatedAt: now,
        expiresAt: refreshed.expiresAt ?? null,
        tokenLast4: refreshed.accessToken.slice(-4),
        accessTokenSealed: this.sealer.seal(refreshed.accessToken, `token:${provider}:${ownerUserId}`),
        refreshTokenSealed: refreshed.refreshToken ? this.sealer.seal(refreshed.refreshToken, `token:${provider}:${ownerUserId}`) : record.refreshTokenSealed,
      });
      this.metrics.increment(`accounts.${provider}.refreshed`);
    }

    return { ...this.publicView(record), accessToken, refreshToken };
  }

  syncStatus(ownerUserId: string, provider: string): UserPlatformSync {
    return this.repo.getPlatformSync(ownerUserId, provider);
  }

  setSyncStatus(status: UserPlatformSync): void {
    this.repo.putPlatformSync(status);
  }

  /** Accounts whose token is about to expire, for the background refresh job. */
  dueForRefresh(users: readonly string[], withinMs = 15 * 60_000): Array<{ provider: string; ownerUserId: string }> {
    const due: Array<{ provider: string; ownerUserId: string }> = [];
    for (const userId of users) {
      for (const account of this.repo.listAccounts(userId)) {
        if (account.status !== 'connected' || !account.expiresAt) continue;
        if (Date.parse(account.expiresAt) - withinMs <= this.clock.now()) due.push({ provider: account.provider, ownerUserId: userId });
      }
    }
    return due;
  }

  maintenance(): void {
    this.repo.purgeOAuthStates(this.nowIso());
  }
}
