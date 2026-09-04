import type { AuditEvent } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface Row {
  id: string;
  occurred_at: string;
  actor_kind: AuditEvent['actor']['kind'];
  actor_id: string;
  actor_display_name: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: AuditEvent['outcome'];
  ip_display: string | null;
  correlation_id: string | null;
  details: string;
}

function toEvent(r: Row): AuditEvent {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    actor: { kind: r.actor_kind, id: r.actor_id, ...(r.actor_display_name ? { displayName: r.actor_display_name } : {}) },
    action: r.action,
    target: r.target_kind && r.target_id !== null ? { kind: r.target_kind, id: r.target_id } : null,
    outcome: r.outcome,
    ipDisplay: r.ip_display,
    correlationId: r.correlation_id,
    details: JSON.parse(r.details) as AuditEvent['details'],
  };
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  insert(e: AuditEvent): void {
    this.db
      .prepare('INSERT INTO audit_events (id, occurred_at, actor_kind, actor_id, actor_display_name, action, target_kind, target_id, outcome, ip_display, correlation_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.occurredAt, e.actor.kind, e.actor.id, e.actor.displayName ?? null, e.action, e.target?.kind ?? null, e.target?.id ?? null, e.outcome, e.ipDisplay, e.correlationId, JSON.stringify(e.details));
  }

  list(options: { limit: number; before?: string | null; action?: string | undefined }): AuditEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.before) {
      clauses.push('occurred_at < ?');
      params.push(options.before);
    }
    if (options.action) {
      clauses.push('action LIKE ?');
      params.push(`${options.action}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit);
    return this.db.prepare<unknown[], Row>(`SELECT * FROM audit_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(...params).map(toEvent);
  }

  count(): number {
    return (this.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM audit_events').get()?.n) ?? 0;
  }

  countSince(action: string, since: string): number {
    return (this.db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM audit_events WHERE action = ? AND occurred_at >= ?').get(action, since)?.n) ?? 0;
  }

  purge(before: string): number {
    return this.db.prepare('DELETE FROM audit_events WHERE occurred_at < ?').run(before).changes;
  }
}
