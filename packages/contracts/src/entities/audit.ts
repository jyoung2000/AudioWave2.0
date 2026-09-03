import { z } from 'zod';
import { IsoDateTime, Uuid } from '../common.js';

export const AuditActor = z.object({
  kind: z.enum(['admin', 'device', 'discord', 'system', 'anonymous']),
  id: z.string().max(200),
  displayName: z.string().max(120).optional(),
});

export const AuditEvent = z.object({
  id: Uuid,
  occurredAt: IsoDateTime,
  actor: AuditActor,
  action: z.string().min(1).max(80).describe('dot.separated action name, e.g. auth.login'),
  target: z.object({ kind: z.string().max(40), id: z.string().max(200) }).nullable().default(null),
  outcome: z.enum(['success', 'denied', 'failure']),
  ipDisplay: z.string().max(80).nullable().default(null).describe('Truncated or keyed-hash form by default'),
  correlationId: z.string().max(80).nullable().default(null),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
