import QRCode from 'qrcode';
import type { Device, DeviceCredential, DeviceCredentialSecret, DeviceKind, PairingSession, Scope } from '@now-playing/contracts';
import { BRANDING, WS_MIN_SUPPORTED_PROTOCOL_VERSION, WS_PROTOCOL_VERSION } from '@now-playing/contracts';
import { DomainError, encodePairingLink, formatPairingCode, generateCredentialSecret, generatePairingCode, hashCredentialSecret, hashPairingCode, keyFingerprint, normalizePairingCode, PAIRING_MAX_ATTEMPTS, timingSafeEqual, uuidv7, verificationFingerprint, verifyPairingCode } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { HubIdentityState } from '../context.js';
import type { DevicesRepository } from '../db/repositories/devices.js';
import { toPairingSession, type PairingRepository, type PairingRow } from '../db/repositories/pairing.js';
import type { Clock, RandomSource } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { NetworkService } from '../network/service.js';
import { randomToken, sha256Hex } from '../util.js';
import type { DeviceService } from './devices.js';

export interface CreatePairingResult {
  sessionId: string;
  code: string;
  expiresAt: string;
  deepLink: string;
  qrSvg: string;
  hubFingerprint: string;
  endpointKnown: boolean;
  note: string;
}

export interface ClaimInput {
  code: string;
  deviceName: string;
  deviceKind: DeviceKind;
  publicKey: string;
  appVersion: string;
  protocolVersion: number;
  platform: string | null;
}

export interface ClaimResult {
  sessionId: string;
  claimSecret: string;
  verificationFingerprint: string;
  hubFingerprint: string;
  hubId: string;
  hubName: string;
  expiresAt: string;
}

/**
 * Pairing: admin creates a short-lived session (10 random Crockford characters = 50 bits, hashed at rest); the joining
 * device claims it with its ephemeral public key; both sides show the verification fingerprint; the admin confirms;
 * the device exchanges the confirmed session exactly once for a scoped credential. Every step is audited.
 */
export class PairingService {
  constructor(
    private readonly repo: PairingRepository,
    private readonly devices: DevicesRepository,
    private readonly deviceService: DeviceService,
    private readonly identity: HubIdentityState,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly random: RandomSource,
  ) {}

  private nowMs(): number {
    return this.clock.now();
  }

  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  async create(input: { deviceKind: DeviceKind; scopes: Scope[]; ttlSeconds: number }, meta: RequestMeta, actor: { id: string; displayName: string }): Promise<CreatePairingResult> {
    const code = generatePairingCode();
    const id = uuidv7(this.nowMs());
    const expiresAt = new Date(this.nowMs() + input.ttlSeconds * 1000).toISOString();
    this.repo.create({ id, hub_id: this.identity.hubId, device_kind: input.deviceKind, requested_scopes: JSON.stringify(input.scopes), code_hash: await hashPairingCode(code, this.identity.hubId), created_by: actor.id, created_at: this.nowIso(), expires_at: expiresAt, max_attempts: PAIRING_MAX_ATTEMPTS });
    const reach = this.network.reachableBaseUrl();
    const endpoint = reach.url ?? `http://localhost:${this.network.toConfig().port}`;
    const deepLink = encodePairingLink({ v: 1, code, endpoint, hubId: this.identity.hubId, fp: this.identity.fingerprint, exp: Math.floor(Date.parse(expiresAt) / 1000) }, BRANDING.urlScheme);
    const qrSvg = await QRCode.toString(deepLink, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    this.metrics.increment('pairing.sessions_created');
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'pairing.create', outcome: 'success', target: { kind: 'pairing', id }, ip: meta.ip, correlationId: meta.correlationId, details: { deviceKind: input.deviceKind, scopes: input.scopes.join(','), ttlSeconds: input.ttlSeconds } });
    const note = reach.reachable ? (reach.warning ?? 'Scan the QR code or type the code into the device.') : `${reach.warning ?? ''} The QR code embeds a localhost endpoint that only works on this machine.`.trim();
    return { sessionId: id, code: formatPairingCode(code), expiresAt, deepLink, qrSvg, hubFingerprint: this.identity.fingerprint, endpointKnown: reach.reachable, note };
  }

  list(): Array<Omit<PairingSession, 'codeHash'>> {
    this.repo.expireStale(this.nowIso());
    return this.repo.list().map((r) => {
      const { codeHash: _c, ...rest } = toPairingSession(r);
      return rest;
    });
  }

  revoke(sessionId: string, meta: RequestMeta, actor: { id: string; displayName: string }): void {
    const row = this.repo.find(sessionId);
    if (!row) throw new DomainError('not-found', 'Pairing session not found');
    if (row.state === 'consumed') throw new DomainError('conflict', 'Session already consumed');
    this.repo.setState(sessionId, 'revoked', this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'pairing.revoke', outcome: 'success', target: { kind: 'pairing', id: sessionId }, ip: meta.ip, correlationId: meta.correlationId });
  }

  /** The joining device presents the code. Wrong codes count against every pending session (bounded brute force). */
  async claim(input: ClaimInput, meta: RequestMeta): Promise<ClaimResult> {
    const now = this.nowIso();
    this.repo.expireStale(now);
    const normalized = normalizePairingCode(input.code);
    this.metrics.increment('pairing.attempts');
    if (!normalized) {
      this.metrics.increment('pairing.failures');
      throw new DomainError('validation', 'Pairing code is not in the expected format');
    }
    const pending = this.repo.pending(now);
    let match: PairingRow | null = null;
    for (const row of pending) {
      if (await verifyPairingCode(normalized, row.hub_id, row.code_hash)) {
        match = row;
        break;
      }
    }
    if (!match) {
      for (const row of pending) {
        const attempts = this.repo.incrementAttempts(row.id, now);
        if (attempts >= row.max_attempts) this.repo.setState(row.id, 'expired', now);
      }
      this.metrics.increment('pairing.failures');
      this.audit.record({ actor: { kind: 'anonymous', id: 'anonymous' }, action: 'pairing.claim', outcome: 'denied', ip: meta.ip, correlationId: meta.correlationId, details: { reason: 'code-mismatch', pendingSessions: pending.length } });
      throw new DomainError('forbidden', 'Unknown or expired pairing code');
    }
    if (input.deviceKind !== match.device_kind) {
      this.metrics.increment('pairing.failures');
      throw new DomainError('validation', `This pairing session was created for a ${match.device_kind}, not a ${input.deviceKind}`);
    }
    if (input.protocolVersion < WS_MIN_SUPPORTED_PROTOCOL_VERSION) {
      throw new DomainError('upgrade-required', `Protocol version ${input.protocolVersion} is older than the minimum supported ${WS_MIN_SUPPORTED_PROTOCOL_VERSION}`);
    }
    const claimSecret = randomToken(this.random, 32);
    const fingerprint = await verificationFingerprint(this.identity.publicKey, input.publicKey, match.id);
    const claimed = this.repo.claim(match.id, { deviceName: input.deviceName, publicKey: input.publicKey, appVersion: input.appVersion, protocolVersion: input.protocolVersion, platform: input.platform, claimSecretHash: sha256Hex(`claim:v1:${claimSecret}`), verificationFingerprint: fingerprint }, now);
    if (!claimed) throw new DomainError('conflict', 'Pairing session was claimed by another device');
    this.audit.record({ actor: { kind: 'anonymous', id: 'anonymous' }, action: 'pairing.claim', outcome: 'success', target: { kind: 'pairing', id: match.id }, ip: meta.ip, correlationId: meta.correlationId, details: { deviceKind: input.deviceKind, deviceName: input.deviceName.slice(0, 80) } });
    return { sessionId: match.id, claimSecret, verificationFingerprint: fingerprint, hubFingerprint: this.identity.fingerprint, hubId: this.identity.hubId, hubName: this.identity.name, expiresAt: match.expires_at };
  }

  confirm(sessionId: string, fingerprint: string, meta: RequestMeta, actor: { id: string; displayName: string }): void {
    const now = this.nowIso();
    this.repo.expireStale(now);
    const row = this.repo.find(sessionId);
    if (!row) throw new DomainError('not-found', 'Pairing session not found');
    if (row.state !== 'claimed') throw new DomainError('conflict', `Session is ${row.state}, not awaiting confirmation`);
    const expected = row.verification_fingerprint ?? '';
    const normalize = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (!timingSafeEqual(normalize(expected), normalize(fingerprint))) {
      this.repo.setState(sessionId, 'revoked', now);
      this.metrics.increment('pairing.failures');
      this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'pairing.confirm', outcome: 'denied', target: { kind: 'pairing', id: sessionId }, ip: meta.ip, correlationId: meta.correlationId, details: { reason: 'fingerprint-mismatch' } });
      throw new DomainError('forbidden', 'Verification fingerprint does not match; the session was revoked');
    }
    if (!this.repo.confirm(sessionId, now)) throw new DomainError('conflict', 'Session could not be confirmed');
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'pairing.confirm', outcome: 'success', target: { kind: 'pairing', id: sessionId }, ip: meta.ip, correlationId: meta.correlationId });
  }

  private checkClaimSecret(row: PairingRow, claimSecret: string): void {
    if (!row.claim_secret_hash || !timingSafeEqual(row.claim_secret_hash, sha256Hex(`claim:v1:${claimSecret}`))) throw new DomainError('forbidden', 'Invalid claim secret');
  }

  status(sessionId: string, claimSecret: string): PairingSession['state'] {
    const now = this.nowIso();
    this.repo.expireStale(now);
    const row = this.repo.find(sessionId);
    if (!row) throw new DomainError('not-found', 'Pairing session not found');
    this.checkClaimSecret(row, claimSecret);
    return row.state;
  }

  /** Single use: the confirmed → consumed transition is an atomic conditional update, so two racing completions cannot both succeed. */
  async complete(sessionId: string, claimSecret: string, meta: RequestMeta): Promise<DeviceCredentialSecret> {
    const now = this.nowIso();
    this.repo.expireStale(now);
    const row = this.repo.find(sessionId);
    if (!row) throw new DomainError('not-found', 'Pairing session not found');
    this.checkClaimSecret(row, claimSecret);
    if (row.state !== 'confirmed') throw new DomainError('conflict', row.state === 'consumed' ? 'Pairing session already used' : `Session is ${row.state}`);
    const deviceId = uuidv7(this.nowMs());
    const credentialId = uuidv7(this.nowMs() + 1);
    const secret = generateCredentialSecret();
    const scopes = JSON.parse(row.requested_scopes) as Scope[];
    const publicKey = row.claimed_public_key ?? '';
    const fingerprint = await keyFingerprint(publicKey);
    const secretHash = await hashCredentialSecret(secret, credentialId);
    const consumed = this.devices.transaction(() => {
      if (!this.repo.consume(sessionId, deviceId, now)) return false;
      const user = this.deviceService.createUserForDevice(row.claimed_device_name ?? 'Device');
      const device: Device = {
        id: deviceId,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        kind: row.device_kind,
        name: row.claimed_device_name ?? 'Device',
        ...(row.claimed_platform ? { platform: row.claimed_platform } : {}),
        publicKeyFingerprint: fingerprint,
        publicKey,
        appVersion: row.claimed_app_version ?? 'unknown',
        protocolVersion: row.claimed_protocol_version ?? WS_PROTOCOL_VERSION,
        scopes,
        lastSeenAt: null,
        revokedAt: null,
        hubUserId: user.id,
      };
      this.devices.createDevice(device);
      const credential: DeviceCredential = { id: credentialId, deviceId, hubId: this.identity.hubId, secretHash, scopes, issuedAt: now, expiresAt: null, lastUsedAt: null, revokedAt: null, label: 'pairing' };
      this.devices.createCredential(credential);
      return true;
    });
    if (!consumed) throw new DomainError('conflict', 'Pairing session already used');
    this.metrics.increment('pairing.completed');
    this.audit.record({ actor: { kind: 'device', id: deviceId, displayName: row.claimed_device_name ?? 'Device' }, action: 'pairing.complete', outcome: 'success', target: { kind: 'device', id: deviceId }, ip: meta.ip, correlationId: meta.correlationId, details: { scopes: scopes.join(',') } });
    const reach = this.network.reachableBaseUrl();
    return { credentialId, deviceId, hubId: this.identity.hubId, hubName: this.identity.name, hubFingerprint: this.identity.fingerprint, endpoint: reach.url ?? `http://localhost:${this.network.toConfig().port}`, secret, scopes, issuedAt: now };
  }

  counts(): { pending: number; attempts: number; failures: number } {
    return { pending: this.repo.countByState('pending', this.nowIso()), attempts: this.metrics.counter('pairing.attempts'), failures: this.metrics.counter('pairing.failures') };
  }

  maintenance(): void {
    const now = this.nowIso();
    this.repo.expireStale(now);
    this.repo.purge(new Date(this.nowMs() - 24 * 3600 * 1000).toISOString());
  }
}
