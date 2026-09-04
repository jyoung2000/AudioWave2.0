import { hashCredentialSecret, timingSafeEqual } from '@now-playing/domain';
import type { DevicesRepository } from '../db/repositories/devices.js';
import type { Clock } from '../deps.js';
import type { Principal } from './principal.js';

const TOUCH_INTERVAL_MS = 60_000;
const BEARER_RE = /^Bearer\s+([A-Za-z0-9-]{36})\.([A-Za-z0-9_-]{20,128})$/;

/** `Authorization: Bearer <credentialId>.<secret>` → device principal. Revoked or expired credentials never authenticate. */
export class DeviceAuthService {
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly repo: DevicesRepository,
    private readonly clock: Clock,
  ) {}

  parseBearer(header: string | undefined): { credentialId: string; secret: string } | null {
    if (!header) return null;
    const m = BEARER_RE.exec(header.trim());
    return m ? { credentialId: m[1]!, secret: m[2]! } : null;
  }

  async authenticate(credentialId: string, secret: string): Promise<Principal | null> {
    const credential = this.repo.findCredential(credentialId);
    if (!credential) return null;
    const expected = await hashCredentialSecret(secret, credentialId);
    if (!timingSafeEqual(expected, credential.secretHash)) return null;
    const now = this.clock.now();
    if (credential.revokedAt) return null;
    if (credential.expiresAt && Date.parse(credential.expiresAt) <= now) return null;
    const device = this.repo.findDevice(credential.deviceId);
    if (!device || device.revokedAt || device.deletedAt) return null;
    const last = this.lastTouched.get(credentialId) ?? 0;
    if (now - last > TOUCH_INTERVAL_MS) {
      this.lastTouched.set(credentialId, now);
      const iso = new Date(now).toISOString();
      this.repo.touchCredential(credentialId, iso);
      this.repo.touchDevice(device.id, iso);
    }
    const user = device.hubUserId ? this.repo.findUser(device.hubUserId) : undefined;
    return { kind: 'device', deviceId: device.id, credentialId, scopes: credential.scopes, hubUserId: device.hubUserId ?? null, displayName: user?.displayName ?? device.name, device };
  }

  async authenticateHeader(header: string | undefined): Promise<Principal | null> {
    const parsed = this.parseBearer(header);
    return parsed ? this.authenticate(parsed.credentialId, parsed.secret) : null;
  }

  forget(credentialId: string): void {
    this.lastTouched.delete(credentialId);
  }
}
