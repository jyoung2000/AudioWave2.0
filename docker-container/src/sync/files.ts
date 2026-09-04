/**
 * Content-addressed file store used by device-to-device transfers.
 *
 * A file is identified by the SHA-256 of its bytes, never by a path. Uploads are chunked and
 * resumable: a device asks HEAD how many bytes the hub already holds, then PUTs from that offset.
 * The staged `.part` file is only promoted to a blob once the whole stream hashes to the name the
 * uploader claimed — an upload that does not match is discarded, so a wrong or tampered body can
 * never take the place of the real content.
 *
 * Authorization is separate from storage. Holding bytes says nothing about who may fetch them:
 * `authorizeRead` requires an actual transfer job (or hub ownership) naming the caller.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DomainError } from '@now-playing/domain';
import type { HubConfig } from '../config.js';
import type { DownloadsRepository } from '../db/repositories/downloads.js';
import type { LibraryRepository } from '../db/repositories/library.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

const HASH_RE = /^[a-f0-9]{64}$/;
/** Uploads larger than this are refused outright rather than filling the volume. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** A staged upload nobody has touched for this long is abandoned. */
const PART_TTL_MS = 24 * 60 * 60 * 1000;

export interface FileStatus {
  contentHash: string;
  /** Bytes the hub can serve right now (a completed blob). */
  completeBytes: number | null;
  /** Bytes staged so far for an in-progress upload; the offset a resumed PUT should use. */
  receivedBytes: number;
  complete: boolean;
}

export interface PutResult {
  receivedBytes: number;
  complete: boolean;
  verified: boolean;
}

export interface ReadHandle {
  stream: Readable;
  start: number;
  end: number;
  size: number;
  partial: boolean;
}

export class FileStore {
  constructor(
    private readonly config: HubConfig,
    private readonly library: LibraryRepository,
    private readonly downloads: DownloadsRepository,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {
    mkdirSync(this.blobDir(), { recursive: true });
    mkdirSync(this.partDir(), { recursive: true });
  }

  private blobDir(): string {
    return join(this.config.dataDir, 'blobs');
  }

  private partDir(): string {
    return join(this.config.dataDir, 'partial');
  }

  private assertHash(contentHash: string): void {
    if (!HASH_RE.test(contentHash)) throw new DomainError('validation', 'A content hash must be 64 lowercase hexadecimal characters');
  }

  private blobPath(contentHash: string): string {
    // The hash is validated first, so it can never contain a separator or traversal sequence.
    return join(this.blobDir(), contentHash);
  }

  private partPath(contentHash: string): string {
    return join(this.partDir(), `${contentHash}.part`);
  }

  /** Where the bytes for this hash actually live: an uploaded blob, or a scanned library file. */
  private resolveExisting(contentHash: string): { path: string; size: number } | null {
    const direct = this.blobPath(contentHash);
    if (existsSync(direct)) return { path: direct, size: statSync(direct).size };
    const blob = this.library.findBlob(contentHash);
    if (blob) {
      const abs = join(this.config.dataDir, blob.relative_path);
      if (existsSync(abs)) return { path: abs, size: statSync(abs).size };
    }
    for (const track of this.library.findTracksByHash(contentHash)) {
      const root = this.library.findRoot(track.rootId);
      if (!root) continue;
      const abs = join(this.config.dataDir, root.handleId, track.relativePath);
      if (existsSync(abs)) return { path: abs, size: statSync(abs).size };
    }
    return null;
  }

  status(contentHash: string): FileStatus {
    this.assertHash(contentHash);
    const existing = this.resolveExisting(contentHash);
    if (existing) return { contentHash, completeBytes: existing.size, receivedBytes: existing.size, complete: true };
    const part = this.partPath(contentHash);
    const receivedBytes = existsSync(part) ? statSync(part).size : 0;
    return { contentHash, completeBytes: null, receivedBytes, complete: false };
  }

  /**
   * Append one chunk. `offset` must equal what the hub already holds — a mismatched offset is a
   * client bug or a race, and silently seeking would corrupt the file, so it is refused with the
   * offset to resume from.
   */
  async putChunk(contentHash: string, offset: number, total: number, body: Buffer): Promise<PutResult> {
    this.assertHash(contentHash);
    if (total > MAX_FILE_BYTES) throw new DomainError('validation', `That file is larger than this hub accepts (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB)`);
    const existing = this.resolveExisting(contentHash);
    if (existing) return { receivedBytes: existing.size, complete: true, verified: true };

    const part = this.partPath(contentHash);
    const have = existsSync(part) ? statSync(part).size : 0;
    if (offset !== have) throw new DomainError('conflict', `Resume from byte ${have}: the hub holds ${have} bytes of this file, the chunk started at ${offset}`);
    if (have + body.byteLength > total) throw new DomainError('validation', 'That chunk would exceed the declared total size');

    const handle = await open(part, have === 0 ? 'w' : 'r+');
    try {
      await handle.write(body, 0, body.byteLength, have);
    } finally {
      await handle.close();
    }
    const receivedBytes = have + body.byteLength;
    this.metrics.increment('files.bytes_received', body.byteLength);

    if (receivedBytes < total) return { receivedBytes, complete: false, verified: false };

    const actual = await hashFile(part);
    if (actual !== contentHash) {
      // The upload does not hash to its claimed name: throw the staged bytes away rather than keep
      // content under a hash that does not describe it.
      await unlink(part).catch(() => undefined);
      this.metrics.increment('files.checksum_failures');
      throw new DomainError('validation', 'The uploaded bytes do not match the content hash; the transfer was discarded');
    }
    renameSync(part, this.blobPath(contentHash));
    this.library.putBlob({ sha256: contentHash, size_bytes: receivedBytes, relative_path: `blobs/${contentHash}`, mime: null, track_id: null, owner_id: null, created_at: new Date(this.clock.now()).toISOString() });
    this.metrics.increment('files.completed');
    return { receivedBytes, complete: true, verified: true };
  }

  /**
   * May this device read these bytes? Yes when a transfer job addressed to it names the hash, when
   * it uploaded them itself, or when the content belongs to the hub's own library.
   */
  authorizeRead(contentHash: string, deviceId: string, isAdmin: boolean): { allowed: boolean; reason: string | null } {
    this.assertHash(contentHash);
    if (isAdmin) return { allowed: true, reason: null };
    const transfers = this.downloads.transfersForHash(contentHash);
    const involved = transfers.find((t) => (t.toDeviceId === deviceId || t.fromDeviceId === deviceId) && t.state !== 'cancelled');
    if (involved) return { allowed: true, reason: null };
    if (this.library.findTracksByHash(contentHash).length) return { allowed: true, reason: null };
    return { allowed: false, reason: 'No transfer addressed to this device references that file' };
  }

  /** Open a (possibly partial) read. `rangeHeader` follows RFC 7233 for a single byte range. */
  openRead(contentHash: string, rangeHeader: string | undefined): ReadHandle {
    this.assertHash(contentHash);
    const existing = this.resolveExisting(contentHash);
    if (!existing) throw new DomainError('not-found', 'The hub does not hold that file');
    const size = existing.size;
    let start = 0;
    let end = size - 1;
    let partial = false;
    const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
    if (match) {
      const [, rawStart, rawEnd] = match;
      if (rawStart === '' && rawEnd !== '') {
        start = Math.max(0, size - Number(rawEnd));
      } else {
        start = Number(rawStart ?? 0);
        if (rawEnd !== '' && rawEnd !== undefined) end = Math.min(size - 1, Number(rawEnd));
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) throw new DomainError('validation', `Range not satisfiable for a ${size}-byte file`);
      partial = true;
    }
    this.metrics.increment('files.reads');
    return { stream: createReadStream(existing.path, { start, end }), start, end, size, partial };
  }

  /** Bytes the hub is holding, for the storage panel in the admin GUI. */
  async usage(): Promise<{ blobs: number; blobBytes: number; partials: number; partialBytes: number }> {
    const count = async (dir: string): Promise<{ files: number; bytes: number }> => {
      let files = 0;
      let bytes = 0;
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        const s = await stat(join(dir, name)).catch(() => null);
        if (s?.isFile()) {
          files += 1;
          bytes += s.size;
        }
      }
      return { files, bytes };
    };
    const blobs = await count(this.blobDir());
    const partials = await count(this.partDir());
    return { blobs: blobs.files, blobBytes: blobs.bytes, partials: partials.files, partialBytes: partials.bytes };
  }

  /** Abandoned `.part` files are dropped; blobs are kept because a transfer may still reference them. */
  async maintenance(): Promise<number> {
    const cutoff = this.clock.now() - PART_TTL_MS;
    let removed = 0;
    for (const name of await readdir(this.partDir()).catch(() => [] as string[])) {
      const path = join(this.partDir(), name);
      const s = await stat(path).catch(() => null);
      if (s && s.mtimeMs < cutoff) {
        rmSync(path, { force: true });
        removed += 1;
      }
    }
    if (removed) this.metrics.increment('files.partials_expired', removed);
    return removed;
  }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Write a buffer into the store under its own hash (used when the hub produces a file itself). */
export async function storeBuffer(dir: string, data: Buffer): Promise<{ contentHash: string; path: string; size: number }> {
  const contentHash = createHash('sha256').update(data).digest('hex');
  const path = join(dir, contentHash);
  if (!existsSync(path)) {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path);
      out.on('error', reject);
      out.on('finish', () => resolve());
      out.end(data);
    });
  }
  return { contentHash, path, size: data.byteLength };
}
