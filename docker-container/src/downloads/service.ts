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
 *
 * Concurrency and control: up to `MAX_CONCURRENT_DOWNLOADS` jobs run at once. A job is claimed
 * atomically in the database before it runs, and every running job owns an `AbortController`, so a
 * cancel or pause stops the transfer (or the FFmpeg/external-tool child) and the runner never
 * writes over a state somebody else set while it was working.
 */
import { toolEnvironment, toolScratchDir } from '../media/tool-env.js';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
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
import { backoffMs } from '../util.js';
import type { ExternalToolAdapter } from '../providers/adapters/external-tool.js';

export const MAX_CONCURRENT_DOWNLOADS = 2;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 5 * 60_000;
/** How long the provider may take to answer with headers. */
const HEADERS_TIMEOUT_MS = 60_000;
/** A body that delivers nothing for this long is treated as stalled. */
const IDLE_TIMEOUT_MS = 60_000;
/** Progress is written and broadcast at most this often (the final state is always written). */
const PROGRESS_INTERVAL_MS = 250;
/** FFmpeg gets a generous but finite budget; a wedged encoder must not hold a slot forever. */
const FFMPEG_TIMEOUT_MS = 30 * 60_000;

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

/** Thrown inside a runner when the job was cancelled, paused or deleted underneath it. */
class JobSuperseded extends Error {
  constructor() {
    super('The job was changed while it was running');
    this.name = 'JobSuperseded';
  }
}

export class DownloadService {
  private stopped = false;
  /** Set by `recover()`: this process owns the download queue, so background ticks may start work. */
  private ownsQueue = false;
  private sink: JobProgressSink | null = null;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();

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
    private readonly hubId: string = '00000000-0000-7000-8000-000000000000',
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

  /**
   * Runner-side save: only while the job is still `running` in the database. A cancel, pause or
   * purge that happened meanwhile wins, and the runner stops instead of overwriting it.
   */
  private saveRunning(job: DownloadRecord, patch: Partial<DownloadRecord>): DownloadRecord {
    const current = this.repo.find(job.id);
    if (!current || current.state !== 'running') throw new JobSuperseded();
    return this.save(job, patch);
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
    this.kick();
    const { outputPath: _p, ...rest } = job;
    return rest;
  }

  action(jobId: string, action: 'cancel' | 'pause' | 'resume' | 'retry', ownerId: string | null): DownloadJob {
    const job = this.repo.find(jobId);
    if (!job) throw new DomainError('not-found', 'Download job not found');
    if (ownerId && job.ownerId !== ownerId) throw new DomainError('forbidden', 'This download belongs to another device');
    const terminal: JobState[] = ['completed', 'cancelled'];
    if (terminal.includes(job.state) && action !== 'retry') throw new DomainError('conflict', `Job is ${job.state}`);
    const running = job.state === 'running' || this.active.has(job.id);
    let next: DownloadRecord;
    switch (action) {
      case 'cancel':
        next = this.save(job, { state: 'cancelled', error: 'Cancelled', completedAt: this.nowIso() });
        this.abortActive(job.id);
        this.cleanupPartial(job);
        break;
      case 'pause':
        if (job.state === 'paused') throw new DomainError('conflict', 'Job is already paused');
        next = this.save(job, { state: 'paused' });
        // No byte-range resume yet: a paused transfer starts again from zero on resume.
        this.abortActive(job.id);
        break;
      case 'resume':
        if (running) throw new DomainError('conflict', 'Job is already running');
        if (job.state === 'queued') throw new DomainError('conflict', 'Job is already queued');
        next = this.save(job, { state: 'queued', error: null, nextRetryAt: null });
        this.kick();
        break;
      case 'retry':
        // A second runner would write the same `.part` file as the first.
        if (running) throw new DomainError('conflict', 'Job is still running; cancel it before retrying');
        next = this.save(job, { state: 'queued', attempts: 0, error: null, nextRetryAt: null, completedAt: null });
        this.kick();
        break;
    }
    const { outputPath: _p, ...rest } = next;
    return rest;
  }

  private abortActive(jobId: string): void {
    this.active.get(jobId)?.controller.abort(new JobSuperseded());
  }

  private cleanupPartial(job: DownloadRecord): void {
    for (const suffix of ['.part', ...Object.keys(FORMAT_ARGS).map((f) => `.part.${f}`)]) {
      const path = join(this.partDir(), `${job.id}${suffix}`);
      try {
        if (existsSync(path)) rmSync(path, { force: true });
      } catch (err) {
        // The runner may still hold the file open; it removes it again when it unwinds.
        this.log.debug({ module: 'downloads', job: job.id, err: err instanceof Error ? err.message : String(err) }, 'could not remove partial file yet');
      }
    }
  }

  /**
   * Start queued and due-retrying work, up to the concurrency limit, without waiting for it.
   * Returns the number of jobs started. Safe to call repeatedly.
   */
  kick(): number {
    if (this.stopped) return 0;
    let started = 0;
    while (this.active.size < MAX_CONCURRENT_DOWNLOADS) {
      const now = this.nowIso();
      const candidates = [...this.repo.byState('queued'), ...this.repo.dueRetries(now)].filter((j) => !this.active.has(j.id));
      let claimed: DownloadRecord | null = null;
      for (const candidate of candidates) {
        if (this.repo.claim(candidate.id, now)) {
          claimed = candidate;
          break;
        }
      }
      if (!claimed) break;
      this.startJob(claimed);
      started += 1;
    }
    return started;
  }

  /** Background tick from the scheduler: only the process that recovered the queue runs downloads. */
  tick(): number {
    return this.ownsQueue ? this.kick() : 0;
  }

  private startJob(job: DownloadRecord): void {
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve() };
    entry.done = this.run(job, controller.signal)
      .catch((err: unknown) => {
        this.log.error({ module: 'downloads', job: job.id, err: err instanceof Error ? err.message : String(err) }, 'download failed unexpectedly');
      })
      .finally(() => {
        this.active.delete(job.id);
        // A finished slot is a free slot.
        this.kick();
      });
    this.active.set(job.id, entry);
  }

  /** Resolves once no job is running (including jobs started while waiting). */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((e) => e.done));
    }
  }

  /** Start any queued work and wait until everything that started has finished. */
  async pump(): Promise<void> {
    this.kick();
    await this.idle();
  }

  private async run(claimed: DownloadRecord, signal: AbortSignal): Promise<void> {
    let job: DownloadRecord = { ...claimed, state: 'running' };
    try {
      job = this.saveRunning(job, { attempts: claimed.attempts + 1, nextRetryAt: null, progress: { ...claimed.progress, stage: 'preflight' } });
    } catch {
      return;
    }
    const sourceId = job.source.providerTrackId ?? job.source.url;
    if (!sourceId || !this.providers.has(job.source.provider)) {
      this.finish(job, { state: 'failed', error: sourceId ? `Unknown provider ${job.source.provider}` : 'The job has no source id', completedAt: this.nowIso() });
      return;
    }
    const adapter = this.providers.get(job.source.provider);
    const part = join(this.partDir(), `${job.id}.part`);

    try {
      const authorized = await adapter.getAuthorizedDownload(sourceId, { actorId: job.ownerId, basis: job.authorization.basis });
      if (!authorized) throw new DomainError('forbidden', 'The provider no longer permits downloading this item');
      signal.throwIfAborted();

      job = this.saveRunning(job, { progress: { ...job.progress, stage: 'downloading' } });
      const bytes = await this.fetchToFile(authorized, part, job, signal);
      signal.throwIfAborted();

      job = this.saveRunning(job, { progress: { ...job.progress, stage: 'verifying', bytesDone: bytes, percent: 100 } });
      const checksum = await hashFile(part);
      // Deduplicate: a completed job with the same checksum already has the bytes.
      const duplicate = this.repo.findCompletedByChecksum(checksum);
      if (duplicate?.outputPath && existsSync(duplicate.outputPath)) {
        rmSync(part, { force: true });
        this.saveRunning(job, { state: 'completed', checksumSha256: checksum, resultSizeBytes: duplicate.resultSizeBytes, resultLocator: duplicate.resultLocator, outputPath: duplicate.outputPath, completedAt: this.nowIso(), error: null, progress: { ...job.progress, stage: 'done', percent: 100 } });
        this.metrics.increment('downloads.deduplicated');
        return;
      }

      let finalPart = part;
      if (job.target.format !== 'original') {
        job = this.saveRunning(job, { progress: { ...job.progress, stage: 'converting' } });
        finalPart = await this.convert(part, job.target.format, signal);
        rmSync(part, { force: true });
      }

      job = this.saveRunning(job, { progress: { ...job.progress, stage: 'finalizing' } });
      const finalChecksum = finalPart === part ? checksum : await hashFile(finalPart);
      // Last chance to notice a cancel before the file becomes part of the blob store.
      signal.throwIfAborted();
      const current = this.repo.find(job.id);
      if (!current || current.state !== 'running') throw new JobSuperseded();
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
        resultLocator: { kind: 'hub-blob', hubId: this.hubId, blobId: finalChecksum },
        outputPath: blobPath,
        completedAt: this.nowIso(),
        error: null,
        progress: { bytesDone: size, bytesTotal: size, speedBps: null, percent: 100, stage: 'done' },
      });
      this.metrics.increment('downloads.completed');
      this.log.info({ module: 'downloads', job: job.id, filename, size }, 'download completed');
    } catch (err) {
      this.cleanupPartial(job);
      if (err instanceof JobSuperseded || signal.aborted) {
        // Cancelled, paused or stopping: whoever aborted already recorded the state (a stopping hub
        // leaves the job `running`, and `recover()` queues it again on the next start).
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof DomainError && (err.code === 'forbidden' || err.code === 'validation' || err.code === 'unsupported');
      if (permanent || job.attempts >= job.maxAttempts) {
        if (this.finish(job, { state: 'failed', error: message.slice(0, 500), completedAt: this.nowIso() })) this.metrics.increment('downloads.failed');
      } else {
        const delay = backoffMs(job.attempts, RETRY_BASE_MS, RETRY_MAX_MS, () => this.random.bytes(1)[0]! / 255);
        if (this.finish(job, { state: 'retrying', error: message.slice(0, 500), nextRetryAt: new Date(this.clock.now() + delay).toISOString() })) this.metrics.increment('downloads.retried');
      }
    }
  }

  /** Record a runner outcome unless the job was changed underneath it. */
  private finish(job: DownloadRecord, patch: Partial<DownloadRecord>): boolean {
    try {
      this.saveRunning(job, patch);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchToFile(authorized: AuthorizedDownload, part: string, job: DownloadRecord, signal: AbortSignal): Promise<number> {
    if (authorized.kind === 'file') {
      if (!existsSync(authorized.path)) throw new DomainError('not-found', 'The source file is no longer on disk');
      await pipeline(createReadStream(authorized.path), createWriteStream(part), { signal });
      return statSync(part).size;
    }
    if (authorized.kind === 'http') {
      // The rate limiter's signal bounds the wait for headers; the body is governed below by the
      // job's own abort signal and an idle timeout, never by a fixed whole-request deadline.
      const res = await this.rateLimiter.run(
        job.source.provider,
        'P2',
        (limiterSignal) =>
          this.http.request(authorized.url, {
            allowedHosts: this.providers.get(job.source.provider).allowedHosts(),
            ...(authorized.headers ? { headers: authorized.headers } : {}),
            timeoutMs: HEADERS_TIMEOUT_MS,
            maxBytes: MAX_BYTES,
            signal: AbortSignal.any([limiterSignal, signal]),
          }),
        { timeoutMs: HEADERS_TIMEOUT_MS },
      );
      if (res.status >= 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new DomainError('unavailable', `The provider responded ${res.status}`);
      }
      if (!res.body) throw new DomainError('unavailable', 'The provider returned no body');
      const total = Number(res.headers.get('content-length') ?? '0') || authorized.sizeBytes || null;
      let done = 0;
      let lastProgressAt = 0;
      const started = this.clock.now();
      const idle = new AbortController();
      let idleTimer: NodeJS.Timeout | null = null;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new DomainError('unavailable', `The download stalled: no data for ${IDLE_TIMEOUT_MS / 1000} s`)), IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      source.on('data', (chunk: Buffer) => {
        armIdle();
        done += chunk.byteLength;
        if (done > MAX_BYTES) {
          source.destroy(new DomainError('validation', 'The download exceeded the 2 GiB limit'));
          return;
        }
        const now = this.clock.now();
        if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        const elapsed = Math.max(1, now - started) / 1000;
        try {
          this.saveRunning(job, { progress: { bytesDone: done, bytesTotal: total, speedBps: done / elapsed, percent: total ? Math.min(100, (done / total) * 100) : null, stage: 'downloading' } });
        } catch (err) {
          source.destroy(err instanceof Error ? err : new JobSuperseded());
        }
      });
      armIdle();
      const combined = AbortSignal.any([signal, idle.signal]);
      try {
        await pipeline(source, createWriteStream(part), { signal: combined });
      } catch (err) {
        if (idle.signal.aborted && !signal.aborted) throw idle.signal.reason as Error;
        throw err;
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      return statSync(part).size;
    }
    return this.runExternalTool(authorized, part, job, signal);
  }

  /**
   * Run the administrator-configured tool. No shell, no cookies, argument template only, hard
   * timeout, and the tool writes to our `.part` path so it cannot choose its own destination.
   */
  private async runExternalTool(authorized: Extract<AuthorizedDownload, { kind: 'external-tool' }>, part: string, job: DownloadRecord, signal: AbortSignal): Promise<number> {
    const adapter = this.providers.get('external-tool') as ExternalToolAdapter;
    if (!this.providers.isEnabled('external-tool')) throw new DomainError('forbidden', 'The external media tool is disabled');
    const template = adapter.commandTemplate();
    const [binary, ...rest] = template;
    if (!binary) throw new DomainError('setup-required', 'No external tool command is configured');
    const args = rest.map((a) => a.replace('{output}', part).replace('{url}', authorized.url));
    if (!args.some((a) => a.includes(part))) args.push(part);
    this.log.info({ module: 'downloads', job: job.id, binary }, 'running external media tool');
    await runChild(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: toolEnvironment(toolScratchDir(this.config.dataDir)) }, adapter.timeoutMs(), signal, {
      spawnError: (message) => new DomainError('unavailable', `The external tool could not be started: ${message}`),
      exitError: (code, stderr) => new DomainError('unavailable', `The external tool exited with code ${code}: ${stderr.slice(-300)}`),
    });
    if (!existsSync(part)) throw new DomainError('unavailable', 'The external tool produced no file');
    return statSync(part).size;
  }

  private async convert(input: string, format: DownloadJob['target']['format'], signal: AbortSignal): Promise<string> {
    const info = await this.ffmpeg();
    if (!info.available || !info.path) throw new DomainError('unsupported', 'FFmpeg is not available in this build, so the file cannot be converted. Choose "original".');
    const args = FORMAT_ARGS[format];
    if (!args) throw new DomainError('validation', `Unsupported output format ${format}`);
    const output = `${input}.${format}`;
    await runChild(info.path, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...args, output], { stdio: ['ignore', 'ignore', 'pipe'] }, FFMPEG_TIMEOUT_MS, signal, {
      spawnError: (message) => new DomainError('unavailable', `FFmpeg could not be started: ${message}`),
      exitError: (code, stderr, timedOut) => new DomainError('unavailable', timedOut ? `FFmpeg did not finish within ${FFMPEG_TIMEOUT_MS / 60_000} minutes` : `FFmpeg failed (code ${code}): ${stderr.slice(-300)}`),
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
        partial = statSync(this.partDir()).isDirectory() ? readdirSync(this.partDir()).length : 0;
      } catch {
        partial = 0;
      }
    }
    return { usedByDownloadsBytes: used, partialFiles: partial };
  }

  /**
   * Jobs left running when the process stopped are queued again on startup, and the queue starts
   * draining. Only the process that owns downloads calls this, which is also what enables the
   * scheduler's periodic `tick()` (retries becoming due) in that process.
   */
  recover(): number {
    const n = this.repo.recoverRunning(this.nowIso());
    if (n > 0) this.log.info({ module: 'downloads', jobs: n }, 're-queued downloads that were interrupted');
    this.ownsQueue = true;
    this.kick();
    return n;
  }

  maintenance(): void {
    const cutoff = new Date(this.clock.now() - 14 * 24 * 3600 * 1000).toISOString();
    for (const job of this.repo.purgeTerminal(cutoff, ['failed', 'cancelled'])) this.cleanupPartial(job);
  }

  /** Stop taking work and abort what is running; interrupted jobs stay `running` for `recover()`. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.active.values()) entry.controller.abort(new Error('The hub is stopping'));
    await this.idle();
  }
}

function extensionOf(filename: string): string {
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(filename);
  return m ? m[0].toLowerCase() : '';
}

/** Spawn without a shell, kill on timeout or abort, and reject with a caller-shaped error. */
function runChild(
  binary: string,
  args: string[],
  options: { stdio: ['ignore', 'ignore' | 'pipe', 'pipe']; env?: NodeJS.ProcessEnv },
  timeoutMs: number,
  signal: AbortSignal,
  errors: { spawnError: (message: string) => Error; exitError: (code: number | null, stderr: string, timedOut: boolean) => Error },
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const child = spawn(binary, args, { stdio: options.stdio, shell: false, ...(options.env ? { env: options.env } : {}) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = `${stderr}${d.toString()}`.slice(-2000);
    });
    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      settle();
      rejectPromise(errors.spawnError(err.message));
    });
    child.on('close', (code) => {
      settle();
      if (signal.aborted) rejectPromise(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      else if (code === 0 && !timedOut) resolvePromise();
      else rejectPromise(errors.exitError(code, stderr, timedOut));
    });
  });
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
