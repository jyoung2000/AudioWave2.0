import type { Device, DeviceView, HubUser, Scope } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { DeviceAuthService } from '../auth/device-auth.js';
import type { DevicesRepository } from '../db/repositories/devices.js';
import type { GroupsRepository } from '../db/repositories/groups.js';
import type { DownloadsRepository } from '../db/repositories/downloads.js';
import type { Clock } from '../deps.js';
import type { RequestMeta } from '../auth/service.js';

/** Live connection facts supplied by the realtime server (kept out of the database). */
export interface PresenceProvider {
  presence(deviceId: string): { online: boolean; latencyMs: number | null; groupId: string | null; connectedAt: string | null; ipDisplay: string | null } | null;
  disconnectDevice(deviceId: string, reason: string): void;
}

export class DeviceService {
  private presenceProvider: PresenceProvider | null = null;

  constructor(
    private readonly repo: DevicesRepository,
    private readonly groups: GroupsRepository,
    private readonly downloads: DownloadsRepository,
    private readonly deviceAuth: DeviceAuthService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  attachPresence(provider: PresenceProvider): void {
    this.presenceProvider = provider;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Every device authenticates as a hub user; a fresh pairing creates one named after the device. */
  createUserForDevice(displayName: string): HubUser {
    const now = this.nowIso();
    const user: HubUser = { id: uuidv7(this.clock.now()), schemaVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, displayName: displayName.slice(0, 80), role: 'member' };
    this.repo.createUser(user);
    return user;
  }

  find(deviceId: string): Device | undefined {
    return this.repo.findDevice(deviceId);
  }

  listViews(): DeviceView[] {
    return this.repo.listDevices().map((d) => this.toView(d));
  }

  toView(d: Device): DeviceView {
    const p = this.presenceProvider?.presence(d.id) ?? null;
    const drift = this.groups.driftForMember(d.id);
    const transfer = this.downloads.activeTransferForDevice(d.id);
    return {
      ...d,
      online: p?.online ?? false,
      latencyMs: p?.latencyMs ?? null,
      connectedGroupId: p?.groupId ?? null,
      connectedAt: p?.connectedAt ?? null,
      ipDisplay: p?.ipDisplay ?? null,
      syncDriftMs: drift && p?.online ? drift.drift_ms : null,
      transferState: transfer ? transfer.state : null,
      credentialCount: this.repo.credentialCount(d.id),
    };
  }

  update(deviceId: string, patch: { name?: string; scopes?: Scope[] }, meta: RequestMeta, actor: { id: string; displayName: string }): Device {
    const existing = this.repo.findDevice(deviceId);
    if (!existing || existing.deletedAt) throw new DomainError('not-found', 'Device not found');
    this.repo.updateDevice(deviceId, patch, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'device.update', outcome: 'success', target: { kind: 'device', id: deviceId }, ip: meta.ip, correlationId: meta.correlationId, details: { renamed: patch.name !== undefined, rescoped: patch.scopes !== undefined } });
    if (patch.scopes) this.presenceProvider?.disconnectDevice(deviceId, 'scopes-changed');
    return this.repo.findDevice(deviceId)!;
  }

  revoke(deviceId: string, meta: RequestMeta, actor: { id: string; displayName: string }): void {
    const existing = this.repo.findDevice(deviceId);
    if (!existing) throw new DomainError('not-found', 'Device not found');
    const changed = this.repo.revokeDevice(deviceId, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'device.revoke', outcome: changed ? 'success' : 'failure', target: { kind: 'device', id: deviceId }, ip: meta.ip, correlationId: meta.correlationId });
    this.deviceAuth.forget(deviceId);
    this.presenceProvider?.disconnectDevice(deviceId, 'revoked');
  }

  displayNameFor(deviceId: string): string {
    const d = this.repo.findDevice(deviceId);
    if (!d) return 'Unknown device';
    const user = d.hubUserId ? this.repo.findUser(d.hubUserId) : undefined;
    return user?.displayName ?? d.name;
  }

  userFor(deviceId: string): HubUser | undefined {
    const d = this.repo.findDevice(deviceId);
    return d?.hubUserId ? this.repo.findUser(d.hubUserId) : undefined;
  }
}
