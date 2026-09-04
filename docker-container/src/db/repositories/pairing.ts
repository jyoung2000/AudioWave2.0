import type { DeviceKind, PairingSession, Scope } from '@now-playing/contracts';
import type { Db } from '../connection.js';

export interface PairingRow {
  id: string;
  hub_id: string;
  device_kind: DeviceKind;
  requested_scopes: string;
  code_hash: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  state: PairingSession['state'];
  claimed_device_name: string | null;
  claimed_public_key: string | null;
  claimed_app_version: string | null;
  claimed_protocol_version: number | null;
  claimed_platform: string | null;
  claim_secret_hash: string | null;
  verification_fingerprint: string | null;
  confirmed_at: string | null;
  consumed_at: string | null;
  resulting_device_id: string | null;
  updated_at: string;
}

export function toPairingSession(r: PairingRow): PairingSession {
  return {
    id: r.id,
    hubId: r.hub_id,
    deviceKind: r.device_kind,
    requestedScopes: JSON.parse(r.requested_scopes) as Scope[],
    codeHash: r.code_hash,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    state: r.state,
    claimedDeviceName: r.claimed_device_name,
    claimedPublicKey: r.claimed_public_key,
    claimedAppVersion: r.claimed_app_version,
    claimedProtocolVersion: r.claimed_protocol_version,
    verificationFingerprint: r.verification_fingerprint,
    consumedAt: r.consumed_at,
    resultingDeviceId: r.resulting_device_id,
  };
}

export class PairingRepository {
  constructor(private readonly db: Db) {}

  create(row: Pick<PairingRow, 'id' | 'hub_id' | 'device_kind' | 'requested_scopes' | 'code_hash' | 'created_by' | 'created_at' | 'expires_at' | 'max_attempts'>): void {
    this.db
      .prepare('INSERT INTO pairing_sessions (id, hub_id, device_kind, requested_scopes, code_hash, created_by, created_at, expires_at, attempts, max_attempts, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
      .run(row.id, row.hub_id, row.device_kind, row.requested_scopes, row.code_hash, row.created_by, row.created_at, row.expires_at, row.max_attempts, 'pending', row.created_at);
  }

  find(id: string): PairingRow | undefined {
    return this.db.prepare<[string], PairingRow>('SELECT * FROM pairing_sessions WHERE id = ?').get(id);
  }

  /** Sessions that could still accept a claim (pending, not expired) — used to match a presented code. */
  pending(now: string): PairingRow[] {
    return this.db.prepare<[string], PairingRow>("SELECT * FROM pairing_sessions WHERE state = 'pending' AND expires_at > ? ORDER BY created_at").all(now);
  }

  list(): PairingRow[] {
    return this.db.prepare<[], PairingRow>('SELECT * FROM pairing_sessions ORDER BY created_at DESC LIMIT 200').all();
  }

  incrementAttempts(id: string, now: string): number {
    this.db.prepare('UPDATE pairing_sessions SET attempts = attempts + 1, updated_at = ? WHERE id = ?').run(now, id);
    return this.find(id)?.attempts ?? 0;
  }

  setState(id: string, state: PairingSession['state'], now: string): void {
    this.db.prepare('UPDATE pairing_sessions SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
  }

  claim(id: string, patch: { deviceName: string; publicKey: string; appVersion: string; protocolVersion: number; platform: string | null; claimSecretHash: string; verificationFingerprint: string }, now: string): boolean {
    return (
      this.db
        .prepare("UPDATE pairing_sessions SET state = 'claimed', claimed_device_name = ?, claimed_public_key = ?, claimed_app_version = ?, claimed_protocol_version = ?, claimed_platform = ?, claim_secret_hash = ?, verification_fingerprint = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
        .run(patch.deviceName, patch.publicKey, patch.appVersion, patch.protocolVersion, patch.platform, patch.claimSecretHash, patch.verificationFingerprint, now, id).changes > 0
    );
  }

  confirm(id: string, now: string): boolean {
    return this.db.prepare("UPDATE pairing_sessions SET state = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ? AND state = 'claimed'").run(now, now, id).changes > 0;
  }

  /** Atomic single-use consumption: only one caller can move confirmed -> consumed. */
  consume(id: string, deviceId: string, now: string): boolean {
    return this.db.prepare("UPDATE pairing_sessions SET state = 'consumed', consumed_at = ?, resulting_device_id = ?, updated_at = ? WHERE id = ? AND state = 'confirmed'").run(now, deviceId, now, id).changes > 0;
  }

  expireStale(now: string): number {
    return this.db.prepare("UPDATE pairing_sessions SET state = 'expired', updated_at = ? WHERE state IN ('pending', 'claimed', 'confirmed') AND expires_at <= ?").run(now, now).changes;
  }

  purge(before: string): number {
    return this.db.prepare("DELETE FROM pairing_sessions WHERE state IN ('consumed', 'expired', 'revoked') AND updated_at < ?").run(before).changes;
  }

  countByState(state: PairingSession['state'], now: string): number {
    if (state === 'pending') return this.db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pairing_sessions WHERE state IN ('pending','claimed','confirmed') AND expires_at > ?").get(now)?.n ?? 0;
    return this.db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM pairing_sessions WHERE state = ?').get(state)?.n ?? 0;
  }

  totalAttempts(): number {
    return this.db.prepare<[], { n: number | null }>('SELECT SUM(attempts) AS n FROM pairing_sessions').get()?.n ?? 0;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
