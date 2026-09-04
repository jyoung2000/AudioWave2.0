import type { AuditEvent } from '@now-playing/contracts';
import { uuidv7 } from '@now-playing/domain';
import type { Logger } from 'pino';
import type { AuditRepository } from '../db/repositories/audit.js';
import type { Clock } from '../deps.js';
import type { NetworkService } from '../network/service.js';
import type { MetricsRegistry } from '../metrics/registry.js';

export interface AuditInput {
  actor: AuditEvent['actor'];
  action: string;
  target?: { kind: string; id: string } | null;
  outcome: AuditEvent['outcome'];
  ip?: string | null;
  correlationId?: string | null;
  details?: AuditEvent['details'];
}

/** Security audit trail. Callers never pass secrets; IPs are minimised through the network policy. */
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly network: NetworkService,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly metrics: MetricsRegistry,
  ) {}

  record(input: AuditInput): AuditEvent {
    const event: AuditEvent = {
      id: uuidv7(this.clock.now()),
      occurredAt: new Date(this.clock.now()).toISOString(),
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      outcome: input.outcome,
      ipDisplay: this.network.ipDisplay(input.ip),
      correlationId: input.correlationId ?? null,
      details: input.details ?? {},
    };
    this.repo.insert(event);
    this.metrics.increment(`audit.${input.outcome}`);
    this.log.info({ module: 'audit', action: event.action, outcome: event.outcome, actor: event.actor.kind, target: event.target, correlationId: event.correlationId, ip: event.ipDisplay }, 'audit');
    return event;
  }

  list(options: { limit: number; before?: string | null; action?: string | undefined }): AuditEvent[] {
    return this.repo.list(options);
  }

  countSince(action: string, since: string): number {
    return this.repo.countSince(action, since);
  }

  /**
   * Audit events age out with the IP-retention window the operator configured, so the trail never
   * outlives the privacy promise made in Admin - Network.
   */
  maintenance(): number {
    const days = Math.max(this.network.current.ipLogging.retentionDays, 30);
    return this.repo.purge(new Date(this.clock.now() - days * 86_400_000).toISOString());
  }
}
