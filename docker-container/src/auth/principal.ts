import type { Device, Scope } from '@now-playing/contracts';

export type Principal =
  | { kind: 'anonymous' }
  | {
      kind: 'admin';
      userId: string;
      username: string;
      sessionIdHash: string;
      csrfToken: string;
      mustChangePassword: boolean;
      expiresAt: string;
    }
  | {
      kind: 'device';
      deviceId: string;
      credentialId: string;
      scopes: Scope[];
      hubUserId: string | null;
      displayName: string;
      device: Device;
    };

/** Stable actor identifier used for group membership, requesters, shares and audit. */
export function actorId(p: Principal): string {
  switch (p.kind) {
    case 'admin':
      return 'admin';
    case 'device':
      return p.deviceId;
    default:
      return 'anonymous';
  }
}

export function actorDisplayName(p: Principal): string {
  switch (p.kind) {
    case 'admin':
      return p.username;
    case 'device':
      return p.displayName;
    default:
      return 'Anonymous';
  }
}

export function hasScope(p: Principal, scope: Scope): boolean {
  return p.kind === 'admin' || (p.kind === 'device' && p.scopes.includes(scope));
}

export function missingScopes(p: Principal, scopes: readonly Scope[]): Scope[] {
  if (p.kind === 'admin') return [];
  if (p.kind !== 'device') return [...scopes];
  return scopes.filter((s) => !p.scopes.includes(s));
}
