import type { Db } from '../connection.js';

export interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string | null;
  must_change_password: number;
  bootstrap: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface AdminSessionRow {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  ip_display: string | null;
  user_agent: string | null;
  revoked_at: string | null;
}

export class AdminRepository {
  constructor(private readonly db: Db) {}

  findByUsername(username: string): AdminUserRow | undefined {
    return this.db.prepare<[string], AdminUserRow>('SELECT * FROM admin_users WHERE username = ?').get(username);
  }

  findById(id: string): AdminUserRow | undefined {
    return this.db.prepare<[string], AdminUserRow>('SELECT * FROM admin_users WHERE id = ?').get(id);
  }

  first(): AdminUserRow | undefined {
    return this.db.prepare<[], AdminUserRow>('SELECT * FROM admin_users ORDER BY created_at LIMIT 1').get();
  }

  createBootstrapAdmin(id: string, username: string, now: string): void {
    this.db
      .prepare('INSERT INTO admin_users (id, username, password_hash, must_change_password, bootstrap, created_at, updated_at) VALUES (?, ?, NULL, 1, 1, ?, ?)')
      .run(id, username, now, now);
  }

  /** Replaces the password and clears the bootstrap flag in one statement (callers wrap in a transaction with the session rotation). */
  setPassword(id: string, passwordHash: string, now: string): void {
    this.db.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0, bootstrap = 0, updated_at = ? WHERE id = ?').run(passwordHash, now, id);
  }

  touchLogin(id: string, now: string): void {
    this.db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(now, id);
  }

  mustChangePassword(): boolean {
    const row = this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM admin_users WHERE must_change_password = 1').get();
    return (row?.n ?? 0) > 0;
  }

  /* ---- sessions ---- */

  createSession(row: Omit<AdminSessionRow, 'revoked_at'>): void {
    this.db
      .prepare('INSERT INTO admin_sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_display, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id_hash, row.user_id, row.csrf_token, row.created_at, row.last_seen_at, row.expires_at, row.ip_display, row.user_agent);
  }

  findSession(idHash: string): AdminSessionRow | undefined {
    return this.db.prepare<[string], AdminSessionRow>('SELECT * FROM admin_sessions WHERE id_hash = ?').get(idHash);
  }

  touchSession(idHash: string, lastSeenAt: string, expiresAt: string): void {
    this.db.prepare('UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(lastSeenAt, expiresAt, idHash);
  }

  revokeSession(idHash: string, now: string): boolean {
    return this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(now, idHash).changes > 0;
  }

  revokeAllSessions(userId: string, now: string, exceptIdHash?: string): void {
    if (exceptIdHash) this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash <> ?').run(now, userId, exceptIdHash);
    else this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
  }

  activeSessions(userId: string, now: string): AdminSessionRow[] {
    return this.db.prepare<[string, string], AdminSessionRow>('SELECT * FROM admin_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(userId, now);
  }

  purgeSessions(before: string): number {
    return this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL AND revoked_at < ?').run(before, before).changes;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
