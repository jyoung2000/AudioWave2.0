import { BRANDING, type SessionInfo } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AdminRepository } from '../db/repositories/admin.js';
import type { Clock, PasswordHashingParams, RandomSource } from '../deps.js';
import { constantTimeEqual, randomToken, sha256Hex } from '../util.js';
import type { AuditService } from './audit.js';
import { checkPasswordPolicy, hashPassword, PRODUCTION_HASHING, verifyPassword } from './passwords.js';
import type { Principal } from './principal.js';

export const SESSION_COOKIE = `${BRANDING.slug}-session`;
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_USERNAME = 'admin';
const BOOTSTRAP_PASSWORD = 'admin';
const TOUCH_INTERVAL_MS = 60_000;

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
}

export interface LoginResult {
  sessionId: string;
  info: SessionInfo;
  expiresAt: string;
}

/**
 * Admin authentication: bootstrap `admin/admin` valid only while the bootstrap flag is set and no password hash exists;
 * argon2id afterwards; sessions hashed at rest with idle and absolute expiry; CSRF token per session.
 */
export class AuthService {
  private mustChangeCache: boolean | null = null;

  constructor(
    private readonly repo: AdminRepository,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly audit: AuditService,
    private readonly hashing: PasswordHashingParams = PRODUCTION_HASHING,
  ) {}

  private now(): number {
    return this.clock.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  ensureBootstrapAdmin(): void {
    if (!this.repo.first()) this.repo.createBootstrapAdmin(uuidv7(this.now()), BOOTSTRAP_USERNAME, this.nowIso());
    this.mustChangeCache = null;
  }

  /** True while the bootstrap password is still in place — gates every setup-required route. */
  mustChangePassword(): boolean {
    if (this.mustChangeCache === null) this.mustChangeCache = this.repo.mustChangePassword();
    return this.mustChangeCache;
  }

  setupComplete(): boolean {
    return !this.mustChangePassword();
  }

  async login(username: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const user = this.repo.findByUsername(username.trim().toLowerCase());
    let ok = false;
    if (user) {
      if (user.bootstrap === 1 && user.password_hash === null) {
        ok = constantTimeEqual(username.trim().toLowerCase(), BOOTSTRAP_USERNAME) && constantTimeEqual(password, BOOTSTRAP_PASSWORD);
      } else if (user.password_hash) {
        ok = await verifyPassword(user.password_hash, password);
      }
    } else {
      // Equalise timing with a real verification.
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', password);
    }
    if (!user || !ok) {
      this.audit.record({ actor: { kind: 'anonymous', id: 'anonymous' }, action: 'auth.login', outcome: 'denied', ip: meta.ip, correlationId: meta.correlationId, details: { username: username.slice(0, 64) } });
      throw new DomainError('unauthenticated', 'Invalid username or password');
    }
    const session = this.createSession(user.id, meta);
    this.repo.touchLogin(user.id, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: user.id, displayName: user.username }, action: 'auth.login', outcome: 'success', ip: meta.ip, correlationId: meta.correlationId, details: { bootstrap: user.bootstrap === 1 } });
    return { sessionId: session.sessionId, expiresAt: session.expiresAt, info: this.infoFor({ kind: 'admin', userId: user.id, username: user.username, sessionIdHash: session.idHash, csrfToken: session.csrfToken, mustChangePassword: user.must_change_password === 1, expiresAt: session.expiresAt }) };
  }

  private createSession(userId: string, meta: RequestMeta): { sessionId: string; idHash: string; csrfToken: string; expiresAt: string } {
    const sessionId = randomToken(this.random, 32);
    const idHash = sha256Hex(`session:v1:${sessionId}`);
    const csrfToken = randomToken(this.random, 32);
    const now = this.now();
    const expiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
    this.repo.createSession({ id_hash: idHash, user_id: userId, csrf_token: csrfToken, created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), expires_at: expiresAt, ip_display: this.audit['network'].ipDisplay(meta.ip), user_agent: meta.userAgent?.slice(0, 200) ?? null });
    return { sessionId, idHash, csrfToken, expiresAt };
  }

  /** Resolve a cookie value to an admin principal (null when missing, expired, revoked or unknown). Touches last-seen at most once a minute. */
  resolveSession(sessionId: string | undefined): Principal | null {
    if (!sessionId || sessionId.length < 16 || sessionId.length > 128) return null;
    const idHash = sha256Hex(`session:v1:${sessionId}`);
    const row = this.repo.findSession(idHash);
    if (!row || row.revoked_at) return null;
    const now = this.now();
    const created = Date.parse(row.created_at);
    if (Date.parse(row.expires_at) <= now || now - created >= SESSION_ABSOLUTE_MS) return null;
    const user = this.repo.findById(row.user_id);
    if (!user) return null;
    let expiresAt = row.expires_at;
    if (now - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
      expiresAt = new Date(Math.min(now + SESSION_IDLE_MS, created + SESSION_ABSOLUTE_MS)).toISOString();
      this.repo.touchSession(idHash, new Date(now).toISOString(), expiresAt);
    }
    return { kind: 'admin', userId: user.id, username: user.username, sessionIdHash: idHash, csrfToken: row.csrf_token, mustChangePassword: user.must_change_password === 1, expiresAt };
  }

  infoFor(principal: Principal | null): SessionInfo {
    if (!principal || principal.kind !== 'admin') return { authenticated: false, setupComplete: this.setupComplete() };
    return { authenticated: true, username: principal.username, mustChangePassword: principal.mustChangePassword, csrfToken: principal.csrfToken, setupComplete: this.setupComplete(), expiresAt: principal.expiresAt };
  }

  /** Verify the current password, store the argon2id hash, clear the bootstrap flag and rotate the session — one transaction. */
  async changePassword(principal: Extract<Principal, { kind: 'admin' }>, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<LoginResult> {
    const user = this.repo.findById(principal.userId);
    if (!user) throw new DomainError('unauthenticated', 'Session user no longer exists');
    const currentOk = user.bootstrap === 1 && user.password_hash === null ? constantTimeEqual(currentPassword, BOOTSTRAP_PASSWORD) : user.password_hash ? await verifyPassword(user.password_hash, currentPassword) : false;
    if (!currentOk) {
      this.audit.record({ actor: { kind: 'admin', id: user.id, displayName: user.username }, action: 'auth.change-password', outcome: 'denied', ip: meta.ip, correlationId: meta.correlationId });
      throw new DomainError('forbidden', 'Current password is incorrect', { details: { field: 'currentPassword' } });
    }
    const policy = checkPasswordPolicy(newPassword, user.username);
    if (!policy.ok) throw new DomainError('validation', policy.reason ?? 'Weak password', { details: { field: 'newPassword' } });
    const hash = await hashPassword(newPassword, this.hashing);
    const result = this.repo.transaction(() => {
      this.repo.setPassword(user.id, hash, this.nowIso());
      this.repo.revokeAllSessions(user.id, this.nowIso());
      return this.createSession(user.id, meta);
    });
    this.mustChangeCache = false;
    this.audit.record({ actor: { kind: 'admin', id: user.id, displayName: user.username }, action: 'auth.change-password', outcome: 'success', ip: meta.ip, correlationId: meta.correlationId });
    return { sessionId: result.sessionId, expiresAt: result.expiresAt, info: this.infoFor({ kind: 'admin', userId: user.id, username: user.username, sessionIdHash: result.idHash, csrfToken: result.csrfToken, mustChangePassword: false, expiresAt: result.expiresAt }) };
  }

  logout(principal: Extract<Principal, { kind: 'admin' }>, meta: RequestMeta): void {
    this.repo.revokeSession(principal.sessionIdHash, this.nowIso());
    this.audit.record({ actor: { kind: 'admin', id: principal.userId, displayName: principal.username }, action: 'auth.logout', outcome: 'success', ip: meta.ip, correlationId: meta.correlationId });
  }

  listSessions(principal: Extract<Principal, { kind: 'admin' }>): Array<{ id: string; createdAt: string; lastSeenAt: string; expiresAt: string; ipDisplay: string | null; userAgent: string | null; current: boolean }> {
    return this.repo.activeSessions(principal.userId, this.nowIso()).map((s) => ({ id: s.id_hash, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, ipDisplay: s.ip_display, userAgent: s.user_agent, current: s.id_hash === principal.sessionIdHash }));
  }

  revokeSession(principal: Extract<Principal, { kind: 'admin' }>, id: string, meta: RequestMeta): boolean {
    const row = this.repo.findSession(id);
    if (!row || row.user_id !== principal.userId) return false;
    const ok = this.repo.revokeSession(id, this.nowIso());
    if (ok) this.audit.record({ actor: { kind: 'admin', id: principal.userId, displayName: principal.username }, action: 'auth.session.revoke', outcome: 'success', target: { kind: 'session', id: id.slice(0, 12) }, ip: meta.ip, correlationId: meta.correlationId });
    return ok;
  }

  purgeExpired(): number {
    return this.repo.purgeSessions(new Date(this.now() - SESSION_ABSOLUTE_MS).toISOString());
  }
}
