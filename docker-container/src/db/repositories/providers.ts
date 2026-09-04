import type { ProviderAccount, UserPlatformSync } from '@now-playing/contracts';
import type { Db } from '../connection.js';

export interface ProviderAppConfigRow {
  provider: string;
  enabled: number;
  client_id: string | null;
  client_secret_sealed: string | null;
  api_key_sealed: string | null;
  application_id: string | null;
  redirect_uri: string | null;
  contact_email: string | null;
  extra: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  provider: string;
  owner_user_id: string;
  owner_device_id: string | null;
  external_user_id: string | null;
  display_name: string | null;
  scopes: string;
  status: ProviderAccount['status'];
  expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  import_cursor: string | null;
  token_last4: string | null;
  access_token_sealed: string | null;
  refresh_token_sealed: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AccountRecord extends ProviderAccount {
  accessTokenSealed: string | null;
  refreshTokenSealed: string | null;
}

export interface OAuthStateRow {
  state: string;
  provider: string;
  owner_user_id: string;
  owner_device_id: string | null;
  code_verifier_sealed: string | null;
  return_to: string | null;
  created_at: string;
  expires_at: string;
}

function toAccount(r: AccountRow): AccountRecord {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    provider: r.provider,
    ownerUserId: r.owner_user_id,
    ownerDeviceId: r.owner_device_id,
    externalUserId: r.external_user_id,
    displayName: r.display_name,
    scopes: JSON.parse(r.scopes) as string[],
    status: r.status,
    expiresAt: r.expires_at,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
    importCursor: r.import_cursor,
    tokenLast4: r.token_last4,
    accessTokenSealed: r.access_token_sealed,
    refreshTokenSealed: r.refresh_token_sealed,
  };
}

export class ProvidersRepository {
  constructor(private readonly db: Db) {}

  /* ---- app configs ---- */
  getConfig(provider: string): ProviderAppConfigRow | undefined {
    return this.db.prepare<[string], ProviderAppConfigRow>('SELECT * FROM provider_app_configs WHERE provider = ?').get(provider);
  }

  allConfigs(): ProviderAppConfigRow[] {
    return this.db.prepare<[], ProviderAppConfigRow>('SELECT * FROM provider_app_configs').all();
  }

  putConfig(row: ProviderAppConfigRow): void {
    this.db
      .prepare(
        'INSERT INTO provider_app_configs (provider, enabled, client_id, client_secret_sealed, api_key_sealed, application_id, redirect_uri, contact_email, extra, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, client_id = excluded.client_id, client_secret_sealed = excluded.client_secret_sealed, api_key_sealed = excluded.api_key_sealed, application_id = excluded.application_id, redirect_uri = excluded.redirect_uri, contact_email = excluded.contact_email, extra = excluded.extra, updated_at = excluded.updated_at',
      )
      .run(row.provider, row.enabled, row.client_id, row.client_secret_sealed, row.api_key_sealed, row.application_id, row.redirect_uri, row.contact_email, row.extra, row.updated_at);
  }

  /* ---- accounts ---- */
  upsertAccount(a: AccountRecord): void {
    this.db
      .prepare(
        'INSERT INTO provider_accounts (id, provider, owner_user_id, owner_device_id, external_user_id, display_name, scopes, status, expires_at, last_sync_at, last_error, import_cursor, token_last4, access_token_sealed, refresh_token_sealed, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, owner_user_id) DO UPDATE SET owner_device_id = excluded.owner_device_id, external_user_id = excluded.external_user_id, display_name = excluded.display_name, scopes = excluded.scopes, status = excluded.status, expires_at = excluded.expires_at, last_sync_at = excluded.last_sync_at, last_error = excluded.last_error, import_cursor = excluded.import_cursor, token_last4 = excluded.token_last4, access_token_sealed = excluded.access_token_sealed, refresh_token_sealed = excluded.refresh_token_sealed, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at',
      )
      .run(a.id, a.provider, a.ownerUserId, a.ownerDeviceId, a.externalUserId, a.displayName, JSON.stringify(a.scopes), a.status, a.expiresAt, a.lastSyncAt, a.lastError, a.importCursor, a.tokenLast4, a.accessTokenSealed, a.refreshTokenSealed, a.createdAt, a.updatedAt, a.deletedAt);
  }

  findAccount(provider: string, ownerUserId: string): AccountRecord | undefined {
    const r = this.db.prepare<[string, string], AccountRow>('SELECT * FROM provider_accounts WHERE provider = ? AND owner_user_id = ? AND deleted_at IS NULL').get(provider, ownerUserId);
    return r ? toAccount(r) : undefined;
  }

  listAccounts(ownerUserId: string): AccountRecord[] {
    return this.db.prepare<[string], AccountRow>('SELECT * FROM provider_accounts WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY provider').all(ownerUserId).map(toAccount);
  }

  deleteAccount(provider: string, ownerUserId: string): boolean {
    return this.db.prepare('DELETE FROM provider_accounts WHERE provider = ? AND owner_user_id = ?').run(provider, ownerUserId).changes > 0;
  }

  /* ---- oauth states ---- */
  createOAuthState(row: OAuthStateRow): void {
    this.db.prepare('INSERT INTO oauth_states (state, provider, owner_user_id, owner_device_id, code_verifier_sealed, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.state, row.provider, row.owner_user_id, row.owner_device_id, row.code_verifier_sealed, row.return_to, row.created_at, row.expires_at);
  }

  takeOAuthState(state: string): OAuthStateRow | undefined {
    const row = this.db.prepare<[string], OAuthStateRow>('SELECT * FROM oauth_states WHERE state = ?').get(state);
    if (row) this.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
    return row;
  }

  purgeOAuthStates(before: string): number {
    return this.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(before).changes;
  }

  /* ---- sync checkpoints ---- */
  getPlatformSync(userId: string, provider: string): UserPlatformSync {
    const r = this.db
      .prepare<[string, string], { user_id: string; provider: string; last_sync_at: string | null; cursor: string | null; snapshot: string | null; etag: string | null; status: UserPlatformSync['status']; last_error: string | null }>('SELECT * FROM user_platform_sync WHERE user_id = ? AND provider = ?')
      .get(userId, provider);
    if (!r) return { userId, provider, lastSyncAt: null, cursor: null, snapshot: null, etag: null, status: 'idle', lastError: null };
    return { userId: r.user_id, provider: r.provider, lastSyncAt: r.last_sync_at, cursor: r.cursor, snapshot: r.snapshot, etag: r.etag, status: r.status, lastError: r.last_error };
  }

  putPlatformSync(s: UserPlatformSync): void {
    this.db
      .prepare('INSERT INTO user_platform_sync (user_id, provider, last_sync_at, cursor, snapshot, etag, status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET last_sync_at = excluded.last_sync_at, cursor = excluded.cursor, snapshot = excluded.snapshot, etag = excluded.etag, status = excluded.status, last_error = excluded.last_error')
      .run(s.userId, s.provider, s.lastSyncAt, s.cursor, s.snapshot, s.etag, s.status, s.lastError);
  }

  /* ---- metadata cache ---- */
  cacheGet(key: string): { value: string; createdAt: string; expiresAt: string } | undefined {
    const r = this.db.prepare<[string], { value: string; created_at: string; expires_at: string }>('SELECT value, created_at, expires_at FROM metadata_cache WHERE cache_key = ?').get(key);
    if (!r) return undefined;
    this.db.prepare('UPDATE metadata_cache SET hits = hits + 1 WHERE cache_key = ?').run(key);
    return { value: r.value, createdAt: r.created_at, expiresAt: r.expires_at };
  }

  cachePut(key: string, provider: string, value: string, createdAt: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO metadata_cache (cache_key, provider, value, created_at, expires_at, hits) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(cache_key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at').run(key, provider, value, createdAt, expiresAt);
  }

  cachePurge(before: string, graceMs: number): number {
    const cutoff = new Date(Date.parse(before) - graceMs).toISOString();
    return this.db.prepare('DELETE FROM metadata_cache WHERE expires_at < ?').run(cutoff).changes;
  }
}
