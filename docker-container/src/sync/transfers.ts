/**
 * Device-to-device transfers, relayed by the hub.
 *
 * The hub never punches holes or brokers a direct connection between two devices
 * (docs/SECURITY.md): the sender uploads to the hub's content-addressed store and the receiver
 * downloads from it. That keeps one authorization point and one audit trail, and means a transfer
 * resumes naturally when either side reconnects.
 *
 * A transfer is a *permission* record as much as a progress record — `FileStore.authorizeRead`
 * consults these rows to decide who may fetch a hash.
 */
import type { TransferJob } from '@now-playing/contracts';
import { DomainError, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { DownloadsRepository, TransferRecord } from '../db/repositories/downloads.js';
import type { DevicesRepository } from '../db/repositories/devices.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { FileStore } from './files.js';

export type TransferAction = 'cancel' | 'pause' | 'resume' | 'retry';

export interface CreateTransfer {
  fromDeviceId: string;
  toDeviceId: string;
  contentHash: string;
  sizeBytes: number;
  trackId?: string | undefined;
  policy?: TransferJob['policy'];
}

/** Notified when a transfer changes so the realtime layer can push it to both devices. */
export type TransferNotifier = (job: TransferJob, deviceIds: readonly string[]) => void;

const MAX_ACTIVE_PER_DEVICE = 3;
const ACTIVE_STATES: ReadonlySet<TransferJob['state']> = new Set(['queued', 'running', 'retrying']);

export class TransferService {
  private notifier: TransferNotifier | null = null;

  constructor(
    private readonly repo: DownloadsRepository,
    private readonly devices: DevicesRepository,
    private readonly files: FileStore,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  onChange(notifier: TransferNotifier): void {
    this.notifier = notifier;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private publicView(record: TransferRecord): TransferJob {
    const { receiverConfirmed: _c, ...job } = record;
    return job;
  }

  private announce(record: TransferRecord): TransferJob {
    const job = this.publicView(record);
    this.notifier?.(job, [record.fromDeviceId, record.toDeviceId]);
    return job;
  }

  create(input: CreateTransfer, meta: RequestMeta, actorDisplayName: string): TransferJob {
    if (input.fromDeviceId === input.toDeviceId) throw new DomainError('validation', 'A device cannot transfer a file to itself');
    const target = this.devices.findDevice(input.toDeviceId);
    if (!target || target.revokedAt) throw new DomainError('not-found', 'That device is not paired with this hub');
    if (!target.scopes.includes('transfers:receive')) throw new DomainError('forbidden', `${target.name} has not been granted permission to receive files`);

    const active = this.repo.listTransfers(input.fromDeviceId).filter((t) => ACTIVE_STATES.has(t.state));
    if (active.length >= MAX_ACTIVE_PER_DEVICE) throw new DomainError('rate-limited', `That device already has ${active.length} transfers in flight; wait for one to finish`);

    // The same file to the same device twice is the same job, not a second one.
    const duplicate = this.repo.transfersForHash(input.contentHash).find((t) => t.toDeviceId === input.toDeviceId && ACTIVE_STATES.has(t.state));
    if (duplicate) return this.publicView(duplicate);

    const status = this.files.status(input.contentHash);
    const now = this.nowIso();
    const record: TransferRecord = {
      id: uuidv7(this.clock.now()),
      kind: 'file',
      // When the hub already holds the bytes the sender has nothing to upload; the receiver can
      // start immediately.
      state: 'queued',
      fromDeviceId: input.fromDeviceId,
      toDeviceId: input.toDeviceId,
      contentHash: input.contentHash,
      sizeBytes: input.sizeBytes,
      bytesDone: status.complete ? input.sizeBytes : status.receivedBytes,
      chunkSizeBytes: 1024 * 1024,
      resumeOffset: status.complete ? input.sizeBytes : status.receivedBytes,
      checksumVerified: status.complete,
      policy: input.policy ?? 'both',
      attempts: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      trackId: input.trackId ?? null,
      receiverConfirmed: false,
    };
    this.repo.insertTransfer(record);
    this.metrics.increment('transfers.created');
    this.audit.record({
      actor: { kind: 'device', id: input.fromDeviceId, displayName: actorDisplayName },
      action: 'transfer.create',
      outcome: 'success',
      target: { kind: 'device', id: input.toDeviceId },
      ip: meta.ip,
      correlationId: meta.correlationId,
      details: { contentHash: input.contentHash.slice(0, 12), sizeBytes: String(input.sizeBytes) },
    });
    return this.announce(record);
  }

  list(deviceId?: string): TransferJob[] {
    return this.repo.listTransfers(deviceId).map((t) => this.publicView(t));
  }

  find(jobId: string): TransferJob {
    const record = this.repo.findTransfer(jobId);
    if (!record) throw new DomainError('not-found', 'No such transfer');
    return this.publicView(record);
  }

  /** Either endpoint of a transfer may act on it; nobody else may even see it. */
  private authorize(jobId: string, actorDeviceId: string | null, isAdmin: boolean): TransferRecord {
    const record = this.repo.findTransfer(jobId);
    if (!record) throw new DomainError('not-found', 'No such transfer');
    if (isAdmin) return record;
    if (actorDeviceId && (record.fromDeviceId === actorDeviceId || record.toDeviceId === actorDeviceId)) return record;
    throw new DomainError('not-found', 'No such transfer');
  }

  act(jobId: string, action: TransferAction, actorDeviceId: string | null, isAdmin: boolean, meta: RequestMeta, actorDisplayName: string): TransferJob {
    const record = this.authorize(jobId, actorDeviceId, isAdmin);
    const now = this.nowIso();
    switch (action) {
      case 'cancel':
        if (record.state === 'completed') throw new DomainError('conflict', 'That transfer has already finished');
        record.state = 'cancelled';
        record.completedAt = now;
        break;
      case 'pause':
        if (!ACTIVE_STATES.has(record.state)) throw new DomainError('conflict', `A ${record.state} transfer cannot be paused`);
        record.state = 'paused';
        break;
      case 'resume':
        if (record.state !== 'paused') throw new DomainError('conflict', 'That transfer is not paused');
        record.state = 'queued';
        record.error = null;
        break;
      case 'retry':
        if (record.state !== 'failed' && record.state !== 'cancelled') throw new DomainError('conflict', 'Only a failed or cancelled transfer can be retried');
        record.state = 'queued';
        record.attempts += 1;
        record.error = null;
        record.completedAt = null;
        // Resume from whatever the hub still holds rather than starting the upload again.
        record.resumeOffset = this.files.status(record.contentHash).receivedBytes;
        record.bytesDone = record.resumeOffset;
        break;
    }
    record.updatedAt = now;
    this.repo.saveTransfer(record);
    this.metrics.increment(`transfers.${action}`);
    this.audit.record({
      actor: { kind: isAdmin ? 'admin' : 'device', id: actorDeviceId ?? 'admin', displayName: actorDisplayName },
      action: `transfer.${action}`,
      outcome: 'success',
      target: { kind: 'job', id: jobId },
      ip: meta.ip,
      correlationId: meta.correlationId,
    });
    return this.announce(record);
  }

  /** Called by the file routes as bytes arrive, so both devices see live progress. */
  recordUpload(contentHash: string, receivedBytes: number, complete: boolean): void {
    const now = this.nowIso();
    for (const record of this.repo.transfersForHash(contentHash)) {
      if (!ACTIVE_STATES.has(record.state) && record.state !== 'paused') continue;
      record.bytesDone = Math.max(record.bytesDone, receivedBytes);
      record.resumeOffset = receivedBytes;
      record.state = complete ? 'running' : 'running';
      record.checksumVerified = complete;
      record.updatedAt = now;
      this.repo.saveTransfer(record);
      this.announce(record);
    }
  }

  /** The receiver acknowledges it has the whole file; only then is the transfer complete. */
  confirmReceipt(jobId: string, deviceId: string): TransferJob {
    const record = this.repo.findTransfer(jobId);
    if (!record) throw new DomainError('not-found', 'No such transfer');
    if (record.toDeviceId !== deviceId) throw new DomainError('forbidden', 'Only the receiving device can confirm a transfer');
    const status = this.files.status(record.contentHash);
    if (!status.complete) throw new DomainError('conflict', 'The hub does not hold the complete file yet');
    record.state = 'completed';
    record.bytesDone = record.sizeBytes;
    record.checksumVerified = true;
    record.receiverConfirmed = true;
    record.completedAt = this.nowIso();
    record.updatedAt = record.completedAt;
    this.repo.saveTransfer(record);
    this.metrics.increment('transfers.completed');
    return this.announce(record);
  }

  /** Mark a transfer failed with a reason the sending device can show. */
  fail(jobId: string, reason: string): void {
    const record = this.repo.findTransfer(jobId);
    if (!record) return;
    record.state = 'failed';
    record.error = reason.slice(0, 500);
    record.updatedAt = this.nowIso();
    this.repo.saveTransfer(record);
    this.metrics.increment('transfers.failed');
    this.announce(record);
  }

  counts(): { queued: number; running: number; failed: number; completed: number } {
    const all = this.repo.listTransfers();
    const count = (state: TransferJob['state']): number => all.filter((t) => t.state === state).length;
    return { queued: count('queued') + count('retrying'), running: count('running'), failed: count('failed'), completed: count('completed') };
  }

  /** A transfer whose file the hub has since dropped cannot resume; say so rather than hang. */
  reconcile(): number {
    let changed = 0;
    for (const record of this.repo.listTransfers()) {
      if (!ACTIVE_STATES.has(record.state)) continue;
      const status = this.files.status(record.contentHash);
      if (status.receivedBytes < record.resumeOffset) {
        record.resumeOffset = status.receivedBytes;
        record.bytesDone = status.receivedBytes;
        record.updatedAt = this.nowIso();
        this.repo.saveTransfer(record);
        changed += 1;
      }
    }
    return changed;
  }
}
