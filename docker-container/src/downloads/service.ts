/**
 * Download jobs.
 *
 * Every job records *why* it is allowed to exist: a `DownloadAuthorizationBasis` the requester
 * acknowledged (their own file, a creator-enabled download, a purchase export, public domain, a
 * licence, or hub-hosted content). The adapter is then asked whether the provider actually permits
 * it — `getAuthorizedDownload` returns null when it does not — so a stream URL never implies a
 * download. Nothing here bypasses DRM, scrapes a page, or reuses a browser's cookies.
 *
 * The worker fetches to a `.part` file, verifies the SHA-256, converts with the bundled FFmpeg when
 * a different output format was asked for, then renames atomically into the blob store. Failures
 * retry with jittered exponential backoff up to `maxAttempts` and then stop with the reason
 * recorded on the job.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { DownloadJob, JobState } from '@now-playing/contracts';
import { DomainError, renderFilenameTemplate, sanitizeFilename, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { HubConfig } from '../config.js';
import type { DownloadRecord, DownloadsRepository } from '../db/repositories/downloads.js';
import type { LibraryRepository } from '../db/repositories/library.js';
import type { Clock, FfmpegInfo, RandomSource } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RateLimitManager } from '../providers/rate-limit-manager.js';
import type { SafeHttpClient } from '../providers/http.js';
import type { AuthorizedDownload } from '../providers/adapter.js';
import type { Logger } from 'pino';
import { backoffMs, sleep } from '../util.js';
import type { ExternalToolAdapter } from '../providers/adapters/external-tool.js';

export const MAX_CONCURRENT_DOWNLOADS = 2;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60_000;

export interface CreateDownloadInput {
  source: DownloadJob['source'];
  authorization: { basis: DownloadJob['authorization']['basis']; evidence?: string | undefined; acknowledged: true };
  target: { destination: Exclude<DownloadJob['target']['destination'], 'ask'>; directoryId?: string | undefined; filenameTemplate?: string | undefined; format: DownloadJob['target']['format']; quality?: string | undefined };
  ownerId: string;
}

export interface JobProgressSink {
  (job: DownloadJob): void;
}

const FORMAT_EXTENSIONS: Record<string, string> = { original: '', mp3: '.mp3', aac: '.m4a', opus: '.opus', flac: '.flac' };
const FORMAT_ARGS: Record<string, string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],
  aac: ['-c:a', 'aac', '-b:a', '256k'],
  opus: ['-c:a', 'libopus', '-b:a', '160k'],
  flac: ['-c:a', 'flac'],
};

export class DownloadService {
  private running = 0;
  private stopped = false;
  private sink: JobProgressSink | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly repo: DownloadsRepository,
    private readonly library: LibraryRepository,
    private readonly providers: ProviderRegistry,
    private readonly rateLimiter: RateLimitManager,
    private readonly http: SafeHttpClient,
    private readonly config: HubConfig,
    private readonly ffmpeg: () => Promise<FfmpegInfo>,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly log: Logger,
  ) {
    mkdirSync(this.blobDir(), { recursive: true });
    mkdirSync(this.partDir(), { recursive: true });
  }

  attachSink(sink: JobProgressSink): void {
    this.sink = sink;
  }

  blobDir(): string {
    return join(this.config.dataDir, 'blobs');
  }

  partDir(): string {
    return join(this.config.dataDir, 'partial');
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private emit(job: DownloadRecord): void {
    const { outputPath: _p, ...rest } = job;
    this.sink?.(rest);
  }

  private save(job: DownloadRecord, patch: Partial<DownloadRecord>): DownloadRecord {
    const next: DownloadRecord = { ...job, ...patch, updatedAt: this.nowIso() };
    this.repo.save(next);
    this.emit(next);
    return next;
  }

  list(ownerId?: string): DownloadJob[] {
    return this.repo.list(ownerId).map(({ outputPath: _p, ...rest }) => rest);
  }

  find(jobId: string): DownloadJob {
    const job = this.repo.find(jobId);
    if (!job) throw new DomainError('not-found', 'Download job not found');
    const { outputPath: _p, ...rest } = job;
    return rest;
  }

  /** Ask the adapter whether this is permitted *before* creating the job, so a refusal is immediate. */
  async create(input: CreateDownloadInput, meta: { ip: string | null; correlationId: string | null }, actorDisplayName: string): Promise<DownloadJob> {
    const providerId = input.source.provider;
    if (!this.providers.has(providerId)) throw new DomainError('not-found', `Unknown provider ${providerId}`);
    if (!this.providers.isEnabled(providerId)) throw new DomainError('forbidden', `${providerId} is disabled`);
    const adapter = this.providers.get(providerId);
    const id = input.source.providerTrackId ?? input.source.url;
    if (!id) throw new DomainError('validation', 'A download needs a provider track id or a URL');

    const authorized = await adapter.getAuthorizedDownload(id, { actorId: input.ownerId, basis: input.authorization.basis });
    if (!authorized) {
      this.audit.record({ actor: { kind: 'device', id: input.ownerId, displayName: actorDisplayName }, action: 'download.refused', outcome: 'denied', target: { kind: 'provider', id: providerId }, ip: meta.ip, correlationId: meta.correlationId, details: { basis: input.authorization.basis } });
      throw new DomainError('forbidden', `${this.providers.descriptor(providerId).displayName} does not permit downloading this item on the basis "${input.authorization.basis}". A stream is not a download.`);
    }

    const now = this.nowIso();
    const job: DownloadRecord = {
      id: uuidv7(this.clock.now()),
      state: 'queued',
      ownerId: input.ownerId,
      source: input.source,
      authorization: { basis: input.authorization.basis, evidence: input.authorization.evidence ?? null, acknowledgedAt: now },
      target: { destination: input.target.destination, directoryId: input.target.directoryId ?? null, filenameTemplate: input.target.filenameTemplate ?? '{artist} - {title}', format: input.target.format, quality: input.target.quality ?? null },
      progress: { bytesDone: 0, bytesTotal: authorized.kind === 'external-tool' ? null : (authorized.sizeBytes ?? null), speedBps: null, percent: null, stage: 'preflight' },
      attempts: 0,
      maxAttempts: 5,
      nextRetryAt: null,
      checksumSha256: null,
      resultLocator: null,
      resultSizeBytes: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      outputPath: null,
    };
    this.repo.insert(job);
    this.metrics.increment('downloads.created');
    this.audit.record({ actor: { kind: 'device', id: input.ownerId, displayName: actorDisplayName }, action: 'download.create', outcome: 'success', target: { kind: 'download', id: job.id }, ip: meta.ip, correlationId: meta.correlationId, details: { provider: providerId, basis: input.authorization.basis, format: input.target.format } });
    this.emit(job);
    void this.pump();
    const { outputPath: _p, ...rest } = job;
    return rest;
  }

  action(jobId: string, action: 'cancel' | 'pause' | 'resume' | 'retry', ownerId: string | null): DownloadJob {
    const job = this.repo.find(jobId);
    if (!job) throw new DomainError('not-found', 'Download job not found');
    if (ownerId && job.ownerId !== ownerId) throw new DomainError('forbidden', 'This download belongs to another device');
    const terminal: JobState[] = ['completed', 'cancelled'];
    if (terminal.includes(job.state) && action !== 'retry') throw new DomainError('conflict', `Job is ${job.state}`);
    let next: DownloadRecord;
    switch (action) {
      case 'cancel':
        next = this.save(job, { state: 'cancelled', error: 'Cancelled', completedAt: this.nowIso() });
        this.cleanupPartial(job);
        break;
      case 'pause':
        next = this.save(job, { state: 'paused' });
        break;
      case 'resume':
        next = this.save(job, { state: 'queued', error: null });
        void this.pump();
        break;
      case 'retry':
        next = this.save(job, { state: 'queued', attempts: 0, error: null, nextRetryAt: null, completedAt: null });
        void this.pump();
        break;
    }
    const { outputPath: _p, ...rest } = next;
    return rest;
  }

  private cleanupPartial(job: DownloadRecord): void {
    const part = join(this.partDir(), `${job.id}.part`);
    if (existsSync(part)) rmSync(part, { force: true });
  }

  /** Start any queued work, up to the concurrency limit. Safe to call repeatedly. */
  async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.loop) return this.loop;
    this.loop = this.drain().finally(() => {
      this.loop = null;
    });
    return this.loop;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const due = [...this.repo.byState('queued'), ...this.repo.dueRetries(this.nowIso())];
      const next = due.find((j) => j.state === 'queued' || j.state === 'retrying');
      if (!next || this.running >= MAX_CONCURRENT_DOWNLOADS) return;
      this.running += 1;
      try {
        await this.run(next);
      } catch (err) {
        this.log.error({ module: 'downloads', job: next.id, err: err instanceof Error ? err.message : String(err) }, 'download failed unexpectedly');
      } finally {
        this.running -= 1;
      }
    }
  }

  private async run(initial: DownloadRecord): Promise<void> {
    let job = this.save(initial, { state: 'running', attempts: initial.attempts + 1, progress: { ...initial.progress, stage: 'preflight' } });
    const adapter = this.providers.get(job.source.provider);
    const sourceId = job.source.providerTrackId ?? job.source.url;
    if (!sourceId) {
      this.save(job, { state: 'failed', error: 'The job has no source id' });
      return;
    }

    try {
      const authorized = await adapter.getAuthorizedDownload(sourceId, { actorId: job.ownerId, basis: job.authorization.basis });
      if (!authorized) throw new DomainError('forbidden', 'The provider no longer permits downloading this item');

      // Deduplicate: a completed job with the same checksum already has the bytes.
      job = this.save(job, { progress: { ...job.progress, stage: 'downloading' } });
      const part = join(this.partDir(), `${job.id}.part`);
      const bytes = await this.fetchToFile(authorized, part, job);

      job = this.save(job, { progress: { ...job.progress, stage: 'verifying', bytesDone: bytes, percent: 100 } });
      const checksum = await hashFile(part);
      const duplicate = this.repo.findCompletedByChecksum(checksum);
      if (duplicate?.outputPath && existsSync(duplicate.outputPath)) {
        rmSync(part, { force: true });
        job = this.save(job, { state: 'completed', checksumSha256: checksum, resultSizeBytes: duplicate.resultSizeBytes, resultLocator: duplicate.resultLocator, outputPath: duplicate.outputPath, completedAt: this.nowIso(), progress: { ...job.progress, stage: 'done', percent: 100 } });
        this.metrics.increment('downloads.deduplicated');
        return;
      }

      let finalPart = part;
      if (job.target.format !== 'original') {
        job = this.save(job, { progress: { ...job.progress, stage: 'converting' } });
        finalPart = await this.convert(part, job.target.format);
        rmSync(part, { force: true });
      }

      job = this.save(job, { progress: { ...job.progress, stage: 'finalizing' } });
      const finalChecksum = finalPart === part ? checksum : await hashFile(finalPart);
      const extension = FORMAT_EXTENSIONS[job.target.format] || extensionOf(authorized.filename) || '.audio';
      const filename = sanitizeFilename(renderFilenameTemplate(job.target.filenameTemplate, { artist: job.source.artistName ?? 'Unknown Artist', title: job.source.title ?? authorized.filename, provider: job.source.provider }, extension));
      const blobPath = join(this.blobDir(), `${finalChecksum}${extension}`);
      if (!existsSync(blobPath)) renameSync(finalPart, blobPath);
      else rmSync(finalPart, { force: true });
      const size = statSync(blobPath).size;

      this.library.putBlob({ sha256: finalChecksum, size_bytes: size, relative_path: `blobs/${finalChecksum}${extension}`, mime: null, track_id: null, owner_id: job.ownerId, created_at: this.nowIso() });
      this.save(job, {
        state: 'completed',
        checksumSha256: finalChecksum,
        resultSizeBytes: size,
        resultLocator: { kind: 'hub-blob', hubId: '00000000-0000-7000-8000-000000000000', blobId: finalChecksum },
        outputPath: blobPath,
        completedAt: this.nowIso(),
        error: null,
        progress: { bytesDone: size, bytesTotal: size, speedBps: null, percent: 100, stage: 'done' },
      });
      this.metrics.increment('downloads.completed');
      this.log.info({ module: 'downloads', job: job.id, filename, size }, 'download completed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cleanupPartial(job);
      const permanent = err instanceof DomainError && (err.code === 'forbidden' || err.code === 'validation' || err.code === 'unsupported');
      if (permanent || job.attempts >= job.maxAttempts) {
        this.save(job, { state: 'failed', error: message.slice(0, 500), completedAt: this.nowIso() });
        this.metrics.increment('downloads.failed');
      } else {
        const delay = backoffMs(job.attempts, RETRY_BASE_MS, RETRY_MAX_MS, () => this.random.bytes(1)[0]! / 255);
        this.save(job, { state: 'retrying', error: message.slice(0, 500), nextRetryAt: new Date(this.clock.now() + delay).toISOString() });
        this.metrics.increment('downloads.retried');
      }
    }
  }

  private async fetchToFile(authorized: AuthorizedDownload, part: string, job: DownloadRecord): Promise<number> {
    if (authorized.kind === 'file') {
      if (!existsSync(authorized.path)) throw new DomainError('not-found', 'The source file is no longer on disk');
      await pipeline(createReadStream(authorized.path), createWriteStream(part));
      return statSync(part).size;
    }
    if (authorized.kind === 'http') {
      const res = await this.rateLimiter.run(job.source.provider, 'P2', (signal) =>
        this.http.request(authorized.url, { allowedHosts: this.providers.get(job.source.provider).allowedHosts(), ...(authorized.headers ? { headers: authorized.headers } : {}), timeoutMs: 60_000, maxBytes: MAX_BYTES, signal }),
      );
      if (res.status >= 400) throw new DomainError('unavailable', `The provider responded ${res.status}`);
      if (!res.body) throw new DomainError('unavailable', 'The provider returned no body');
      const total = Number(res.headers.get('content-length') ?? '0') || authorized.sizeBytes || null;
      let done = 0;
      const started = this.clock.now();
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on('data', (chunk: Buffer) => {
        done += chunk.byteLength;
        if (done > MAX_BYTES) source.destroy(new DomainError('validation', 'The download exceeded the 2 GiB limit'));
        const elapsed = Math.max(1, this.clock.now() - started) / 1000;
        this.save(job, { progress: { bytesDone: done, bytesTotal: total, speedBps: done / elapsed, percent: total ? Math.min(100, (done / total) * 100) : null, stage: 'downloading' } });
      });
      await pipeline(source, createWriteStream(part));
      return statSync(part).size;
    }
    return this.runExternalTool(authorized, part, job);
  }

  /**
   * Run the administrator-configured tool. No shell, no cookies, argument template only, hard
   * timeout, and the tool writes to our `.part` path so it cannot choose its own destination.
   */
  private async runExternalTool(authorized: Extract<AuthorizedDownload, { kind: 'external-tool' }>, part: string, job: DownloadRecord): Promise<number> {
    const adapter = this.providers.get('external-tool') as ExternalToolAdapter;
    if (!this.providers.isEnabled('external-tool')) throw new DomainError('forbidden', 'The external media tool is disabled');
    const template = adapter.commandTemplate();
    const [binary, ...rest] = template;
    if (!binary) throw new DomainError('setup-required', 'No external tool command is configured');
    const args = rest.map((a) => a.replace('{output}', part).replace('{url}', authorized.url));
    if (!args.some((a) => a.includes(part))) args.push(part);
    this.log.info({ module: 'downloads', job: job.id, binary }, 'running external media tool');
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }, shell: false });
      const timer = setTimeout(() => child.kill('SIGKILL'), adapter.timeoutMs());
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr = `${stderr}${d.toString()}`.slice(-2000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        rejectPromise(new DomainError('unavailable', `The external tool could not be started: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else rejectPromise(new DomainError('unavailable', `The external tool exited with code ${code}: ${stderr.slice(-300)}`));
      });
    });
    if (!existsSync(part)) throw new DomainError('unavailable', 'The external tool produced no file');
    return statSync(part).size;
  }

  private async convert(input: string, format: DownloadJob['target']['format']): Promise<string> {
    const info = await this.ffmpeg();
    if (!info.available || !info.path) throw new DomainError('unsupported', 'FFmpeg is not available in this build, so the file cannot be converted. Choose "original".');
    const args = FORMAT_ARGS[format];
    if (!args) throw new DomainError('validation', `Unsupported output format ${format}`);
    const output = `${input}.${format}`;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(info.path!, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...args, output], { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr = `${stderr}${d.toString()}`.slice(-2000);
      });
      child.on('error', (err) => rejectPromise(new DomainError('unavailable', `FFmpeg could not be started: ${err.message}`)));
      child.on('close', (code) => (code === 0 ? resolvePromise() : rejectPromise(new DomainError('unavailable', `FFmpeg failed: ${stderr.slice(-300)}`))));
    });
    return output;
  }

  /** Available output formats, from what the bundled FFmpeg build can actually encode. */
  async formats(): Promise<{ formats: Array<{ format: DownloadJob['target']['format']; available: boolean; lossy: boolean; reason: string | null; qualityNote: string }>; ffmpeg: FfmpegInfo }> {
    const info = await this.ffmpeg();
    const has = (encoder: string): boolean => info.encoders.includes(encoder);
    const entry = (format: DownloadJob['target']['format'], encoder: string | null, lossy: boolean, qualityNote: string) => ({
      format,
      available: encoder === null ? true : info.available && has(encoder),
      lossy,
      reason: encoder === null ? null : !info.available ? 'FFmpeg is not available in this build' : has(encoder) ? null : `This FFmpeg build has no ${encoder} encoder`,
      qualityNote,
    });
    return {
      formats: [
        entry('original', null, false, 'Byte-for-byte copy of the source; no re-encoding, no quality loss'),
        entry('mp3', 'libmp3lame', true, 'VBR ~190 kbps (-q:a 2). Re-encoding a lossy source loses more quality.'),
        entry('aac', 'aac', true, '256 kbps CBR. Re-encoding a lossy source loses more quality.'),
        entry('opus', 'libopus', true, '160 kbps VBR; best quality per byte at this bitrate.'),
        entry('flac', 'flac', false, 'Lossless, but no better than the source: converting from a lossy file cannot restore it.'),
      ],
      ffmpeg: info,
    };
  }

  counts(): Record<JobState, number> {
    return this.repo.counts();
  }

  storage(): { usedByDownloadsBytes: number; partialFiles: number } {
    let used = 0;
    for (const blob of this.library.listBlobs()) used += blob.size_bytes;
    let partial = 0;
    if (existsSync(this.partDir())) {
      try {
        partial = statSync(this.partDir()).isDirectory() ? require('node:fs').readdirSync(this.partDir()).length : 0;
      } catch {
        partial = 0;
      }
    }
    return { usedByDownloadsBytes: used, partialFiles: partial };
  }

  /** Jobs left running when the process stopped are queued again on startup. */
  recover(): number {
    const n = this.repo.recoverRunning(this.nowIso());
    if (n > 0) this.log.info({ module: 'downloads', jobs: n }, 're-queued downloads that were interrupted');
    return n;
  }

  maintenance(): void {
    const cutoff = new Date(this.clock.now() - 14 * 24 * 3600 * 1000).toISOString();
    for (const job of this.repo.purgeTerminal(cutoff, ['failed', 'cancelled'])) this.cleanupPartial(job);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop?.catch(() => undefined);
    await sleep(0);
  }
}

function extensionOf(filename: string): string {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(filename);
  return m ? m[0].toLowerCase() : '';
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', rejectPromise)
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}
