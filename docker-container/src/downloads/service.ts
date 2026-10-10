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
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DOWNLOAD_BATCH_CAP, type DownloadBatchResult, type DownloadJob, type DownloadSource, type DownloadTags, type JobState } from '@now-playing/contracts';
import { DomainError, renderFilenameTemplate, sanitizeFilename, uuidv7 } from '@now-playing/domain';
import { toolCommand } from '@now-playing/domain/tool-install';
import { fromSpotdl, fromYtDlp, isCollectionUrl, mergeTags, titleFromUrl, type ProbedEntry } from '../media/media-metadata.js';
import { FORMAT_ARGS, FORMAT_EXTENSIONS, planFinalise, readExisting, writeId3Lyrics } from './finalise.js';
import type { AuditService } from '../auth/audit.js';
import type { HubConfig } from '../config.js';
import type { DownloadRecord, DownloadsRepository } from '../db/repositories/downloads.js';
import type { LibraryRepository } from '../db/repositories/library.js';
import type { Clock, FfmpegInfo, RandomSource } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RateLimitManager } from '../providers/rate-limit-manager.js';
import type { SafeHttpClient } from '../providers/http.js';
import type { AuthorizedDownload, ProviderAdapter } from '../providers/adapter.js';
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

export interface CreateBatchInput {
  url: string;
  authorization: CreateDownloadInput['authorization'];
  target: CreateDownloadInput['target'];
  ownerId: string;
}

/** Files a tool leaves beside the audio: its notes, the thumbnail it embedded, its partial downloads. */
const SIDECAR = /\.(info\.json|spotdl|json|jpe?g|png|webp|part|ytdl|temp|tmp|m3u8?|lrc|txt|description)$/i;

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
    const adapter = this.adapterFor(providerId);
    const id = input.source.providerTrackId ?? input.source.url;
    if (!id) throw new DomainError('validation', 'A download needs a provider track id or a URL');
    if (providerId === 'external-tool' && isCollectionUrl(id)) throw new DomainError('validation', 'That link is a playlist, set or album. Send it to POST /downloads/batch, which makes one download per entry.');

    const authorized = await adapter.getAuthorizedDownload(id, { actorId: input.ownerId, basis: input.authorization.basis });
    if (!authorized) this.refused(providerId, input.ownerId, input.authorization.basis, meta, actorDisplayName);
    // A requester may suggest tags; the batch a job belongs to is only ever the hub's to set.
    const job = this.insertJob(input, { ...input.source, batch: null }, authorized.kind === 'external-tool' ? null : (authorized.sizeBytes ?? null));
    this.audit.record({ actor: { kind: 'device', id: input.ownerId, displayName: actorDisplayName }, action: 'download.create', outcome: 'success', target: { kind: 'download', id: job.id }, ip: meta.ip, correlationId: meta.correlationId, details: { provider: providerId, basis: input.authorization.basis, format: input.target.format } });
    this.kick();
    const { outputPath: _p, ...rest } = job;
    return rest;
  }

  /**
   * A link through the external tool, which may name a list: one job per entry (at most
   * `DOWNLOAD_BATCH_CAP`), each with the tags the listing gave it, all under the request's one
   * rights basis — which is checked against every entry, not only the list. Entries this requester
   * already has, entries the listing marks unavailable, and entries on a host the tool may not
   * reach are skipped and named in the answer. A single-track link makes one job.
   */
  async createBatch(input: CreateBatchInput, meta: { ip: string | null; correlationId: string | null }, actorDisplayName: string): Promise<DownloadBatchResult> {
    const adapter = this.adapterFor('external-tool') as ExternalToolAdapter;
    const basis = input.authorization.basis;
    const listAuthorized = await adapter.getAuthorizedDownload(input.url, { actorId: input.ownerId, basis });
    if (!listAuthorized || listAuthorized.kind !== 'external-tool') this.refused('external-tool', input.ownerId, basis, meta, actorDisplayName);
    const probe = await adapter.probe(listAuthorized.url);
    const base: CreateDownloadInput = { source: { provider: 'external-tool', providerTrackId: null, url: null, locator: null, title: null, artistName: null }, authorization: input.authorization, target: input.target, ownerId: input.ownerId };
    const existing = this.repo.activeSourceUrls(input.ownerId, input.target.format);
    const skipped: DownloadBatchResult['batch']['skipped'] = [];
    const created = (job: DownloadRecord, details: Record<string, unknown> = {}): void => {
      this.audit.record({ actor: { kind: 'device', id: input.ownerId, displayName: actorDisplayName }, action: 'download.create', outcome: 'success', target: { kind: 'download', id: job.id }, ip: meta.ip, correlationId: meta.correlationId, details: { provider: 'external-tool', basis, format: input.target.format, ...details } });
    };

    if (probe.kind === 'track') {
      const url = listAuthorized.url;
      const summary = { id: null, kind: 'track' as const, title: probe.tags.title, listed: 1, cap: DOWNLOAD_BATCH_CAP, capped: false };
      if (existing.has(url)) {
        skipped.push({ url, title: probe.tags.title, reason: 'duplicate' });
        return { batch: { ...summary, created: 0, skipped }, items: [], message: 'There is already a download of this track, so no new one was made.' };
      }
      const job = this.insertJob(base, { ...base.source, url, title: probe.tags.title, artistName: probe.tags.artist, tags: probe.tags, batch: null }, null);
      created(job);
      this.kick();
      const { outputPath: _p, ...rest } = job;
      return { batch: { ...summary, created: 1, skipped }, items: [rest], message: `Downloading “${probe.tags.title}”.` };
    }

    const listed = Math.max(probe.listed ?? 0, probe.entries.length);
    const capped = listed > DOWNLOAD_BATCH_CAP;
    const take: ProbedEntry[] = [];
    const seen = new Set<string>();
    for (const entry of probe.entries) {
      if (take.length >= DOWNLOAD_BATCH_CAP) break;
      const title = entry.tags?.title ?? titleFromUrl(entry.url);
      if (entry.unavailable) {
        skipped.push({ url: entry.url, title, reason: 'unavailable' });
        continue;
      }
      // The rights basis covers every entry, and every entry must be on a host the tool may reach.
      const authorized = await adapter.getAuthorizedDownload(entry.url, { actorId: input.ownerId, basis });
      if (!authorized || authorized.kind !== 'external-tool') {
        skipped.push({ url: entry.url, title, reason: 'not-allowed' });
        continue;
      }
      if (seen.has(authorized.url) || existing.has(authorized.url)) {
        skipped.push({ url: authorized.url, title, reason: 'duplicate' });
        continue;
      }
      seen.add(authorized.url);
      take.push({ ...entry, url: authorized.url });
    }

    const batchId = uuidv7(this.clock.now());
    const items: DownloadJob[] = take.map((entry, index) => {
      const job = this.insertJob(base, { ...base.source, url: entry.url, title: entry.tags?.title ?? titleFromUrl(entry.url), artistName: entry.tags?.artist ?? null, tags: entry.tags, batch: { id: batchId, title: probe.title, index, total: take.length } }, null);
      created(job, { batch: batchId });
      const { outputPath: _p, ...rest } = job;
      return rest;
    });
    this.metrics.increment('downloads.batches');
    this.kick();
    const parts = [`${probe.title ? `“${probe.title}”` : 'This list'}: ${items.length} download${items.length === 1 ? '' : 's'} made`];
    if (capped) parts.push(`it lists ${listed} entries and one request takes at most ${DOWNLOAD_BATCH_CAP}`);
    if (skipped.length) parts.push(`${skipped.length} skipped`);
    return {
      batch: { id: items.length ? batchId : null, kind: 'playlist', title: probe.title, listed: probe.listed ?? probe.entries.length, created: items.length, cap: DOWNLOAD_BATCH_CAP, capped, skipped: skipped.slice(0, DOWNLOAD_BATCH_CAP) },
      items,
      message: `${parts.join('; ')}.`.slice(0, 500),
    };
  }

  private adapterFor(providerId: string): ProviderAdapter {
    if (!this.providers.has(providerId)) throw new DomainError('not-found', `Unknown provider ${providerId}`);
    if (!this.providers.isEnabled(providerId)) throw new DomainError('forbidden', `${providerId} is disabled`);
    return this.providers.get(providerId);
  }

  private refused(providerId: string, ownerId: string, basis: string, meta: { ip: string | null; correlationId: string | null }, actorDisplayName: string): never {
    this.audit.record({ actor: { kind: 'device', id: ownerId, displayName: actorDisplayName }, action: 'download.refused', outcome: 'denied', target: { kind: 'provider', id: providerId }, ip: meta.ip, correlationId: meta.correlationId, details: { basis } });
    throw new DomainError('forbidden', `${this.providers.descriptor(providerId).displayName} does not permit downloading this item on the basis "${basis}". A stream is not a download.`);
  }

  private insertJob(input: CreateDownloadInput, source: DownloadSource, bytesTotal: number | null): DownloadRecord {
    const now = this.nowIso();
    const job: DownloadRecord = {
      id: uuidv7(this.clock.now()),
      state: 'queued',
      ownerId: input.ownerId,
      source,
      authorization: { basis: input.authorization.basis, evidence: input.authorization.evidence ?? null, acknowledgedAt: now },
      target: { destination: input.target.destination, directoryId: input.target.directoryId ?? null, filenameTemplate: input.target.filenameTemplate ?? '{artist} - {title}', format: input.target.format, quality: input.target.quality ?? null },
      progress: { bytesDone: 0, bytesTotal, speedBps: null, percent: null, stage: 'preflight' },
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
    this.emit(job);
    return job;
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
    // The `.part` file, the job's working directory (the tool's output, the tags file, the cover) and
    // anything an older build left under the job's name.
    let names: string[];
    try {
      names = readdirSync(this.partDir()).filter((name) => name.startsWith(job.id));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        rmSync(join(this.partDir(), name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      } catch (err) {
        // The runner may still hold the file open; it removes it again when it unwinds.
        this.log.debug({ module: 'downloads', job: job.id, err: err instanceof Error ? err.message : String(err) }, 'could not remove partial file yet');
      }
    }
  }

  /** A directory of the job's own: the tool's output, the tags file and the cover go here. */
  private workDir(job: DownloadRecord): string {
    return join(this.partDir(), `${job.id}.d`);
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
      const downloaded = await this.fetchToFile(authorized, part, job, signal);
      signal.throwIfAborted();
      // What the tool reported about the track fills the gaps in what the job already knew.
      if (downloaded.reported) {
        const tags = mergeTags(job.source.tags, downloaded.reported);
        const knewTags = Boolean(job.source.tags);
        job = this.saveRunning(job, { source: { ...job.source, tags, title: knewTags ? (job.source.title ?? tags?.title ?? null) : (tags?.title ?? job.source.title), artistName: knewTags ? (job.source.artistName ?? tags?.artist ?? null) : (tags?.artist ?? job.source.artistName) } });
      }

      job = this.saveRunning(job, { progress: { ...job.progress, stage: 'verifying', bytesDone: downloaded.bytes, percent: 100 } });
      const checksum = await hashFile(downloaded.path);
      // Deduplicate: a completed job with the same checksum already has the bytes.
      const duplicate = this.repo.findCompletedByChecksum(checksum);
      if (duplicate?.outputPath && existsSync(duplicate.outputPath)) {
        this.cleanupPartial(job);
        this.saveRunning(job, { state: 'completed', checksumSha256: checksum, resultSizeBytes: duplicate.resultSizeBytes, resultLocator: duplicate.resultLocator, outputPath: duplicate.outputPath, completedAt: this.nowIso(), error: null, progress: { ...job.progress, stage: 'done', percent: 100 } });
        this.metrics.increment('downloads.deduplicated');
        return;
      }

      // Tags, cover and format, in one FFmpeg pass.
      const inputExtension = downloaded.extension || extensionOf(authorized.filename);
      if (job.target.format !== 'original') job = this.saveRunning(job, { progress: { ...job.progress, stage: 'converting' } });
      const finalised = await this.finalise(job, downloaded.path, inputExtension, signal);
      const finalPart = finalised?.output ?? downloaded.path;

      job = this.saveRunning(job, { progress: { ...job.progress, stage: 'finalizing' } });
      const finalChecksum = finalPart === downloaded.path ? checksum : await hashFile(finalPart);
      // Last chance to notice a cancel before the file becomes part of the blob store.
      signal.throwIfAborted();
      const current = this.repo.find(job.id);
      if (!current || current.state !== 'running') throw new JobSuperseded();
      const extension = finalised?.extension ?? (FORMAT_EXTENSIONS[job.target.format] || inputExtension || '.audio');
      const filename = sanitizeFilename(renderFilenameTemplate(job.target.filenameTemplate, { artist: job.source.artistName ?? 'Unknown Artist', title: job.source.title ?? authorized.filename, provider: job.source.provider }, extension));
      const blobPath = join(this.blobDir(), `${finalChecksum}${extension}`);
      if (!existsSync(blobPath)) renameSync(finalPart, blobPath);
      else rmSync(finalPart, { force: true });
      this.cleanupPartial(job);
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

  private async fetchToFile(authorized: AuthorizedDownload, part: string, job: DownloadRecord, signal: AbortSignal): Promise<Downloaded> {
    if (authorized.kind === 'file') {
      if (!existsSync(authorized.path)) throw new DomainError('not-found', 'The source file is no longer on disk');
      await pipeline(createReadStream(authorized.path), createWriteStream(part), { signal });
      return { path: part, bytes: statSync(part).size, extension: extensionOf(authorized.filename), reported: null };
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
      return { path: part, bytes: statSync(part).size, extension: extensionOf(authorized.filename), reported: null };
    }
    return this.runExternalTool(authorized, part, job, signal);
  }

  /**
   * Run the external tool. No shell, no cookies, a command line built from the preset (or the
   * operator's template), a hard timeout. A preset runs in a directory of the job's own and the hub
   * takes the one audio file that appears there — the tool picks the extension (`--extract-audio`
   * turns a WebM into `.opus`; spotDL names its files itself) but never the place. An operator's
   * template writes the `.part` path it is given, exactly as before.
   */
  private async runExternalTool(authorized: Extract<AuthorizedDownload, { kind: 'external-tool' }>, part: string, job: DownloadRecord, signal: AbortSignal): Promise<Downloaded> {
    const adapter = this.providers.get('external-tool') as ExternalToolAdapter;
    if (!this.providers.isEnabled('external-tool')) throw new DomainError('forbidden', 'The external media tool is disabled');
    const info = await this.ffmpeg();
    const workDir = this.workDir(job);
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const plan = adapter.downloadPlan(authorized.url, { outputDir: workDir, output: part, ffmpeg: info.available ? info.path : null });
    // spotDL keeps settings in its home directory: a new, empty one inside the job's, every run.
    const home = plan.preset?.needsHome ? join(workDir, '.home') : null;
    if (home) mkdirSync(home, { recursive: true });
    this.log.info({ module: 'downloads', job: job.id, binary: plan.binary, tool: plan.preset?.tool ?? 'template' }, 'running external media tool');
    await runChild(plan.binary, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: adapter.toolEnvironment(home) }, adapter.timeoutMs(), signal, {
      spawnError: (message) => new DomainError('unavailable', `The external tool could not be started: ${message}`),
      exitError: (code, stderr) => new DomainError('unavailable', `The external tool exited with code ${code}: ${stderr.slice(-300)}`),
    });
    if (plan.mode === 'file') {
      if (!existsSync(part)) throw new DomainError('unavailable', 'The external tool produced no file');
      return { path: part, bytes: statSync(part).size, extension: extensionOf(authorized.filename), reported: null };
    }
    const produced = readdirSync(workDir).filter((name) => !name.startsWith('.') && !SIDECAR.test(name) && statSync(join(workDir, name)).isFile());
    if (!produced.length) throw new DomainError('unavailable', 'The external tool finished without producing a file');
    if (produced.length > 1) throw new DomainError('validation', `The external tool produced ${produced.length} files, and a download job is one track. Send a playlist link to POST /downloads/batch.`);
    const file = join(workDir, produced[0]!);
    return { path: file, bytes: statSync(file).size, extension: extname(file).toLowerCase(), reported: plan.preset ? this.readReported(plan.preset.tool, join(workDir, plan.preset.infoFile), authorized.url) : null };
  }

  /** What the tool wrote about the track beside it (`media.info.json`, `song.spotdl`), as tags. */
  private readReported(tool: 'yt-dlp' | 'spotdl', path: string, url: string): DownloadTags | null {
    try {
      if (!existsSync(path)) return null;
      const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const probe = tool === 'spotdl' ? fromSpotdl(json, url) : fromYtDlp(json, url);
      return probe?.kind === 'track' ? probe.tags : null;
    } catch {
      return null;
    }
  }

  /**
   * One FFmpeg pass: the job's tags over the file's own, the cover carried across, and the format
   * asked for (`finalise.ts`). Null when there is nothing to do — the original was asked for and
   * there is nothing to tag it with, or no FFmpeg to do it with.
   */
  private async finalise(job: DownloadRecord, input: string, inputExtension: string, signal: AbortSignal): Promise<{ output: string; extension: string } | null> {
    const info = await this.ffmpeg();
    const converting = job.target.format !== 'original';
    if (!info.available || !info.path) {
      if (converting) throw new DomainError('unsupported', 'FFmpeg is not available in this build, so the file cannot be converted. Choose "original".');
      return null;
    }
    if (converting && !FORMAT_ARGS[job.target.format]) throw new DomainError('validation', `Unsupported output format ${job.target.format}`);
    const workDir = this.workDir(job);
    mkdirSync(workDir, { recursive: true });
    const plan = planFinalise({ file: input, inputExtension, workDir, format: job.target.format, tags: job.source.tags, existing: await readExisting(input), sourceUrl: job.source.url });
    if (!plan) return null;
    await runChild(info.path, plan.args, { stdio: ['ignore', 'ignore', 'pipe'] }, FFMPEG_TIMEOUT_MS, signal, {
      spawnError: (message) => new DomainError('unavailable', `FFmpeg could not be started: ${message}`),
      exitError: (code, stderr, timedOut) => new DomainError('unavailable', timedOut ? `FFmpeg did not finish within ${FFMPEG_TIMEOUT_MS / 60_000} minutes` : `FFmpeg failed (code ${code}): ${stderr.slice(-300)}`),
    });
    // FFmpeg cannot write an MP3's USLT frame; the lyrics go in afterwards. Best effort: a tag this
    // cannot rewrite keeps the file as FFmpeg made it, without lyrics.
    if (plan.id3Lyrics && !writeId3Lyrics(plan.output, plan.id3Lyrics)) this.log.warn({ module: 'downloads', job: job.id }, 'lyrics not embedded: the MP3’s ID3 tag is not one the hub rewrites');
    return { output: plan.output, extension: plan.extension };
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
        entry('original', null, false, 'The source’s own audio, not re-encoded, so no quality loss. A file from the external tool is tagged on the way in.'),
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

interface Downloaded {
  /** The downloaded file: the `.part` file, or the one the tool wrote in the job's directory. */
  path: string;
  bytes: number;
  /** Its real extension, when known (`.opus`, `.m4a`, `.mp3`), or ''. */
  extension: string;
  /** What the tool wrote about the track, when it wrote anything. */
  reported: DownloadTags | null;
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
    // A tool that is a JavaScript file is run with this Node (how the tests stand in for the real ones).
    const { command, prefix } = toolCommand(binary);
    const child = spawn(command, [...prefix, ...args], { stdio: options.stdio, shell: false, windowsHide: true, ...(options.env ? { env: options.env } : {}) });
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
