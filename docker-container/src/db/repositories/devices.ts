import type { Device, DeviceCredential, HubUser, Scope } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface DeviceRow {
  id: string;
  kind: Device['kind'];
  name: string;
  platform: string | null;
  public_key_fingerprint: string;
  public_key: string | null;
  app_version: string;
  protocol_version: number;
  scopes: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  hub_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface CredentialRow {
  id: string;
  device_id: string;
  hub_id: string;
  secret_hash: string;
  scopes: string;
  issued_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  label: string | null;
}

interface HubUserRow {
  id: string;
  display_name: string;
  role: 'admin' | 'member';
  avatar: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    kind: r.kind,
    name: r.name,
    ...(r.platform ? { platform: r.platform } : {}),
    publicKeyFingerprint: r.public_key_fingerprint,
    ...(r.public_key ? { publicKey: r.public_key } : {}),
    appVersion: r.app_version,
    protocolVersion: r.protocol_version,
    scopes: JSON.parse(r.scopes) as Scope[],
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
    ...(r.hub_user_id ? { hubUserId: r.hub_user_id } : {}),
  };
}

export function toCredential(r: CredentialRow): DeviceCredential {
  return {
    id: r.id,
    deviceId: r.device_id,
    hubId: r.hub_id,
    secretHash: r.secret_hash,
    scopes: JSON.parse(r.scopes) as Scope[],
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    ...(r.label ? { label: r.label } : {}),
  };
}

export function toHubUser(r: HubUserRow): HubUser {
  return {
    id: r.id,
    schemaVersion: 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    displayName: r.display_name,
    role: r.role,
    ...(r.avatar ? { avatar: JSON.parse(r.avatar) as HubUser['avatar'] } : {}),
  };
}

export class DevicesRepository {
  constructor(private readonly db: Db) {}

  /* ---- hub users ---- */
  createUser(user: HubUser): void {
    this.db.prepare('INSERT INTO hub_users (id, display_name, role, avatar, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.id, user.displayName, user.role, user.avatar ? JSON.stringify(user.avatar) : null, user.createdAt, user.updatedAt, user.deletedAt);
  }

  findUser(id: string): HubUser | undefined {
    const r = this.db.prepare<[string], HubUserRow>('SELECT * FROM hub_users WHERE id = ?').get(id);
    return r ? toHubUser(r) : undefined;
  }

  listUsers(): HubUser[] {
    return this.db.prepare<[], HubUserRow>('SELECT * FROM hub_users WHERE deleted_at IS NULL ORDER BY created_at').all().map(toHubUser);
  }

  /* ---- devices ---- */
  createDevice(d: Device): void {
    this.db
      .prepare('INSERT INTO devices (id, kind, name, platform, public_key_fingerprint, public_key, app_version, protocol_version, scopes, last_seen_at, revoked_at, hub_user_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, d.kind, d.name, d.platform ?? null, d.publicKeyFingerprint, d.publicKey ?? null, d.appVersion, d.protocolVersion, JSON.stringify(d.scopes), d.lastSeenAt, d.revokedAt, d.hubUserId ?? null, d.createdAt, d.updatedAt, d.deletedAt);
  }

  findDevice(id: string): Device | undefined {
    const r = this.db.prepare<[string], DeviceRow>('SELECT * FROM devices WHERE id = ?').get(id);
    return r ? toDevice(r) : undefined;
  }

  listDevices(): Device[] {
    return this.db.prepare<[], DeviceRow>('SELECT * FROM devices WHERE deleted_at IS NULL ORDER BY created_at').all().map(toDevice);
  }

  updateDevice(id: string, patch: { name?: string; scopes?: Scope[] }, now: string): void {
    if (patch.name !== undefined) this.db.prepare('UPDATE devices SET name = ?, updated_at = ? WHERE id = ?').run(patch.name, now, id);
    if (patch.scopes !== undefined) {
      this.db.prepare('UPDATE devices SET scopes = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.scopes), now, id);
      this.db.prepare('UPDATE device_credentials SET scopes = ? WHERE device_id = ? AND revoked_at IS NULL').run(JSON.stringify(patch.scopes), id);
    }
  }

  touchDevice(id: string, now: string): void {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, id);
  }

  /** Revoke the device and every credential in one transaction. */
  revokeDevice(id: string, now: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, now, id).changes;
      this.db.prepare('UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(now, id);
      return changed > 0;
    })();
  }

  /* ---- credentials ---- */
  createCredential(c: DeviceCredential): void {
    this.db
      .prepare('INSERT INTO device_credentials (id, device_id, hub_id, secret_hash, scopes, issued_at, expires_at, last_used_at, revoked_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.deviceId, c.hubId, c.secretHash, JSON.stringify(c.scopes), c.issuedAt, c.expiresAt, c.lastUsedAt, c.revokedAt, c.label ?? null);
  }

  findCredential(id: string): DeviceCredential | undefined {
    const r = this.db.prepare<[string], CredentialRow>('SELECT * FROM device_credentials WHERE id = ?').get(id);
    return r ? toCredential(r) : undefined;
  }

  credentialCount(deviceId: string): number {
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM device_credentials WHERE device_id = ? AND revoked_at IS NULL').get(deviceId)?.n ?? 0;
  }

  touchCredential(id: string, now: string): void {
    this.db.prepare('UPDATE device_credentials SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
