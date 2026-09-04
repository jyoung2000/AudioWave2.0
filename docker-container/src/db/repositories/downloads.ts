import type { DownloadJob, TransferJob } from '@now-playing/contracts';
import type { Db } from '../connection.js';

interface DownloadRow {
  id: string;
  state: DownloadJob['state'];
  owner_id: string;
  source: string;
  authorization: string;
  target: string;
  progress: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  checksum_sha256: string | null;
  result_locator: string | null;
  result_size_bytes: number | null;
  error: string | null;
  output_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DownloadRecord extends DownloadJob {
  outputPath: string | null;
}

function toDownload(r: DownloadRow): DownloadRecord {
  return {
    id: r.id,
    state: r.state,
    ownerId: r.owner_id,
    source: JSON.parse(r.source) as DownloadJob['source'],
    authorization: JSON.parse(r.authorization) as DownloadJob['authorization'],
    target: JSON.parse(r.target) as DownloadJob['target'],
    progress: JSON.parse(r.progress) as DownloadJob['progress'],
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextRetryAt: r.next_retry_at,
    checksumSha256: r.checksum_sha256,
    resultLocator: r.result_locator ? (JSON.parse(r.result_locator) as DownloadJob['resultLocator']) : null,
    resultSizeBytes: r.result_size_bytes,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    outputPath: r.output_path,
  };
}

interface TransferRow {
  id: string;
  kind: TransferJob['kind'];
  state: TransferJob['state'];
  from_device_id: string;
  to_device_id: string;
  content_hash: string;
  size_bytes: number;
  bytes_done: number;
  chunk_size_bytes: number;
  resume_offset: number;
  checksum_verified: number;
  receiver_confirmed: number;
  policy: TransferJob['policy'];
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  track_id: string | null;
}

export interface TransferRecord extends TransferJob {
  receiverConfirmed: boolean;
}

function toTransfer(r: TransferRow): TransferRecord {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    fromDeviceId: r.from_device_id,
    toDeviceId: r.to_device_id,
    contentHash: r.content_hash,
    sizeBytes: r.size_bytes,
    bytesDone: r.bytes_done,
    chunkSizeBytes: r.chunk_size_bytes,
    resumeOffset: r.resume_offset,
    checksumVerified: r.checksum_verified === 1,
    policy: r.policy,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
    trackId: r.track_id,
    receiverConfirmed: r.receiver_confirmed === 1,
  };
}

export class DownloadsRepository {
  constructor(private readonly db: Db) {}

  insert(job: DownloadRecord): void {
    this.db
      .prepare('INSERT INTO download_jobs (id, state, owner_id, source, authorization, target, progress, attempts, max_attempts, next_retry_at, checksum_sha256, result_locator, result_size_bytes, error, output_path, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.state, job.ownerId, JSON.stringify(job.source), JSON.stringify(job.authorization), JSON.stringify(job.target), JSON.stringify(job.progress), job.attempts, job.maxAttempts, job.nextRetryAt, job.checksumSha256, job.resultLocator ? JSON.stringify(job.resultLocator) : null, job.resultSizeBytes, job.error, job.outputPath, job.createdAt, job.updatedAt, job.completedAt);
  }

  save(job: DownloadRecord): void {
    this.db
      .prepare('UPDATE download_jobs SET state = ?, progress = ?, attempts = ?, next_retry_at = ?, checksum_sha256 = ?, result_locator = ?, result_size_bytes = ?, error = ?, output_path = ?, updated_at = ?, completed_at = ?, target = ? WHERE id = ?')
      .run(job.state, JSON.stringify(job.progress), job.attempts, job.nextRetryAt, job.checksumSha256, job.resultLocator ? JSON.stringify(job.resultLocator) : null, job.resultSizeBytes, job.error, job.outputPath, job.updatedAt, job.completedAt, JSON.stringify(job.target), job.id);
  }

  find(id: string): DownloadRecord | undefined {
    const r = this.db.prepare<[string], DownloadRow>('SELECT * FROM download_jobs WHERE id = ?').get(id);
    return r ? toDownload(r) : undefined;
  }

  list(ownerId?: string): DownloadRecord[] {
    if (ownerId) return this.db.prepare<[string], DownloadRow>('SELECT * FROM download_jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500').all(ownerId).map(toDownload);
    return this.db.prepare<[], DownloadRow>('SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT 500').all().map(toDownload);
  }

  byState(state: DownloadJob['state']): DownloadRecord[] {
    return this.db.prepare<[string], DownloadRow>('SELECT * FROM download_jobs WHERE state = ? ORDER BY created_at').all(state).map(toDownload);
  }

  dueRetries(now: string): DownloadRecord[] {
    return this.db.prepare<[string], DownloadRow>("SELECT * FROM download_jobs WHERE state = 'retrying' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY created_at").all(now).map(toDownload);
  }

  recoverRunning(now: string): number {
    return this.db.prepare("UPDATE download_jobs SET state = 'queued', updated_at = ? WHERE state = 'running'").run(now).changes;
  }

  findCompletedByChecksum(sha256: string): DownloadRecord | undefined {
    const r = this.db.prepare<[string], DownloadRow>("SELECT * FROM download_jobs WHERE checksum_sha256 = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 1").get(sha256);
    return r ? toDownload(r) : undefined;
  }

  counts(): Record<DownloadJob['state'], number> {
    const rows = this.db.prepare<[], { state: DownloadJob['state']; n: number }>('SELECT state, COUNT(*) AS n FROM download_jobs GROUP BY state').all();
    const out: Record<DownloadJob['state'], number> = { queued: 0, running: 0, paused: 0, retrying: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  purgeTerminal(before: string, states: DownloadJob['state'][]): DownloadRecord[] {
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db.prepare<unknown[], DownloadRow>(`SELECT * FROM download_jobs WHERE state IN (${placeholders}) AND updated_at < ?`).all(...states, before);
    this.db.prepare(`DELETE FROM download_jobs WHERE state IN (${placeholders}) AND updated_at < ?`).run(...states, before);
    return rows.map(toDownload);
  }

  /* ---- transfers ---- */
  insertTransfer(t: TransferRecord): void {
    this.db
      .prepare('INSERT INTO transfer_jobs (id, kind, state, from_device_id, to_device_id, content_hash, size_bytes, bytes_done, chunk_size_bytes, resume_offset, checksum_verified, receiver_confirmed, policy, attempts, error, created_at, updated_at, completed_at, track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.kind, t.state, t.fromDeviceId, t.toDeviceId, t.contentHash, t.sizeBytes, t.bytesDone, t.chunkSizeBytes, t.resumeOffset, t.checksumVerified ? 1 : 0, t.receiverConfirmed ? 1 : 0, t.policy, t.attempts, t.error, t.createdAt, t.updatedAt, t.completedAt, t.trackId);
  }

  saveTransfer(t: TransferRecord): void {
    this.db
      .prepare('UPDATE transfer_jobs SET state = ?, bytes_done = ?, resume_offset = ?, checksum_verified = ?, receiver_confirmed = ?, attempts = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?')
      .run(t.state, t.bytesDone, t.resumeOffset, t.checksumVerified ? 1 : 0, t.receiverConfirmed ? 1 : 0, t.attempts, t.error, t.updatedAt, t.completedAt, t.id);
  }

  findTransfer(id: string): TransferRecord | undefined {
    const r = this.db.prepare<[string], TransferRow>('SELECT * FROM transfer_jobs WHERE id = ?').get(id);
    return r ? toTransfer(r) : undefined;
  }

  listTransfers(deviceId?: string): TransferRecord[] {
    if (deviceId) return this.db.prepare<[string, string], TransferRow>('SELECT * FROM transfer_jobs WHERE from_device_id = ? OR to_device_id = ? ORDER BY created_at DESC LIMIT 500').all(deviceId, deviceId).map(toTransfer);
    return this.db.prepare<[], TransferRow>('SELECT * FROM transfer_jobs ORDER BY created_at DESC LIMIT 500').all().map(toTransfer);
  }

  transfersForHash(contentHash: string): TransferRecord[] {
    return this.db.prepare<[string], TransferRow>("SELECT * FROM transfer_jobs WHERE content_hash = ? AND state IN ('queued', 'running', 'paused', 'retrying')").all(contentHash).map(toTransfer);
  }

  activeTransferForDevice(deviceId: string): TransferRecord | undefined {
    const r = this.db.prepare<[string, string], TransferRow>("SELECT * FROM transfer_jobs WHERE (from_device_id = ? OR to_device_id = ?) AND state IN ('queued', 'running', 'paused', 'retrying') ORDER BY updated_at DESC LIMIT 1").get(deviceId, deviceId);
    return r ? toTransfer(r) : undefined;
  }
}
