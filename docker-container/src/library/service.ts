import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parseFile } from 'music-metadata';
import type { Artwork, LibraryRoot, ProviderCapabilities, SearchResult, Track, TrackRef } from '@now-playing/contracts';
import { API_PREFIX, routePath, routes } from '@now-playing/contracts';
import { DomainError, isSafeRelativePath, joinInsideRoot, LocalSearchIndex, uuidv7, type IndexedTrackLike } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { RequestMeta } from '../auth/service.js';
import type { HubConfig } from '../config.js';
import type { HubTrackRecord, LibraryRepository } from '../db/repositories/library.js';
import type { Clock } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';
import type { Logger } from 'pino';
import { caps, result as buildResult } from '../providers/adapters/base.js';
import { decodeCursor, encodeCursor } from '../util.js';

export const AUDIO_EXTENSIONS: Record<string, string> = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.ape': 'audio/x-ape', '.wma': 'audio/x-ms-wma' };
const BROWSER_DECODABLE = new Set(['audio/mpeg', 'audio/flac', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm']);
const EXTERNAL_PREFIX = 'ext:';
const MAX_DEPTH = 12;
const TOMBSTONE_RETENTION_MS = 30 * 24 * 3600 * 1000;

export const HUB_TRACK_CAPABILITIES: ProviderCapabilities = caps({ metadata: 'available', search: 'available', preview: 'available', playback: 'available', userOwnedDownload: 'available', groupSync: 'exact', eq: 'available' });
export const PUBLIC_DOMAIN_CAPABILITIES: ProviderCapabilities = caps({ metadata: 'available', search: 'available', preview: 'available', playback: 'available', creatorDownload: 'available', userOwnedDownload: 'available', groupSync: 'exact', eq: 'available' });

export interface ScanReport {
  rootId: string;
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  skipped: Array<{ path: string; reason: string }>;
  durationMs: number;
}

export interface RangeStream {
  stream: NodeJS.ReadableStream;
  start: number;
  end: number;
  size: number;
  mime: string;
  filename: string;
}

interface IndexedHub extends IndexedTrackLike {
  id: string;
}

/**
 * Hub-hosted library: directories inside the data volume (admin-registered) plus configuration-registered external
 * roots (the public-domain fixture set). Files are hashed for identity, tagged with music-metadata and streamed with
 * HTTP range support. Paths never leave this service.
 */
export class LibraryService {
  private readonly externalRoots = new Map<string, { path: string; tag: string }>();
  private index = new LocalSearchIndex<IndexedHub>();
  private indexDirty = true;
  private scanning = false;

  constructor(
    private readonly repo: LibraryRepository,
    private readonly config: HubConfig,
    private readonly hubId: string,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {
    mkdirSync(join(config.dataDir, 'library'), { recursive: true });
    mkdirSync(join(config.dataDir, 'artwork'), { recursive: true });
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /* ------------------------------------------------------------------ roots */

  libraryDir(): string {
    return join(this.config.dataDir, 'library');
  }

  listRoots(): LibraryRoot[] {
    return this.repo.listRoots().map((r) => this.withLiveStatus(r));
  }

  private withLiveStatus(root: LibraryRoot): LibraryRoot {
    const abs = this.absoluteRootPath(root);
    if (!abs || !existsSync(abs)) return { ...root, status: 'missing' };
    return root;
  }

  addRoot(relativePath: string, displayName: string, meta: RequestMeta, actor: { id: string; displayName: string }): LibraryRoot {
    const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!cleaned || !isSafeRelativePath(cleaned)) throw new DomainError('validation', 'relativePath must be a safe path inside the data volume library directory');
    const abs = joinInsideRoot(this.libraryDir(), cleaned);
    if (!abs) throw new DomainError('validation', 'relativePath escapes the library directory');
    if (this.repo.findRootByPath(cleaned)) throw new DomainError('conflict', 'A root for this path already exists');
    mkdirSync(abs, { recursive: true });
    const now = this.nowIso();
    const root: LibraryRoot = { id: uuidv7(this.clock.now()), schemaVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, deviceId: this.hubId, kind: 'hub-directory', displayName, handleId: cleaned, status: 'connected', lastScanAt: null, lastScanError: null, trackCount: 0, watch: true, scanCheckpoint: null };
    this.repo.createRoot(root);
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'library.root.add', outcome: 'success', target: { kind: 'library-root', id: root.id }, ip: meta.ip, correlationId: meta.correlationId, details: { displayName } });
    return root;
  }

  /** Configuration-registered root outside the data volume (read-only), identified by a stable tag. */
  registerExternalRoot(absolutePath: string, displayName: string, tag: string): LibraryRoot {
    const handle = `${EXTERNAL_PREFIX}${tag}`;
    this.externalRoots.set(handle, { path: resolve(absolutePath), tag });
    const existing = this.repo.findRootByPath(handle);
    if (existing) return existing;
    const now = this.nowIso();
    const root: LibraryRoot = { id: uuidv7(this.clock.now()), schemaVersion: 1, createdAt: now, updatedAt: now, deletedAt: null, deviceId: this.hubId, kind: 'hub-directory', displayName, handleId: handle, status: 'connected', lastScanAt: null, lastScanError: null, trackCount: 0, watch: true, scanCheckpoint: null };
    this.repo.createRoot(root);
    return root;
  }

  rootByTag(tag: string): LibraryRoot | undefined {
    return this.repo.findRootByPath(`${EXTERNAL_PREFIX}${tag}`);
  }

  removeRoot(rootId: string, meta: RequestMeta, actor: { id: string; displayName: string }): void {
    const root = this.repo.findRoot(rootId);
    if (!root) throw new DomainError('not-found', 'Root not found');
    if (root.handleId.startsWith(EXTERNAL_PREFIX)) throw new DomainError('forbidden', 'Configuration-registered roots are removed through the environment');
    this.repo.removeRoot(rootId, this.nowIso());
    this.indexDirty = true;
    this.audit.record({ actor: { kind: 'admin', id: actor.id, displayName: actor.displayName }, action: 'library.root.remove', outcome: 'success', target: { kind: 'library-root', id: rootId }, ip: meta.ip, correlationId: meta.correlationId });
  }

  absoluteRootPath(root: LibraryRoot): string | null {
    if (root.handleId.startsWith(EXTERNAL_PREFIX)) return this.externalRoots.get(root.handleId)?.path ?? null;
    return joinInsideRoot(this.libraryDir(), root.handleId);
  }

  /* ------------------------------------------------------------------ scans */

  async scanAll(): Promise<ScanReport[]> {
    const reports: ScanReport[] = [];
    for (const root of this.repo.listRoots()) reports.push(await this.scanRoot(root.id));
    return reports;
  }

  async scanRoot(rootId: string): Promise<ScanReport> {
    const root = this.repo.findRoot(rootId);
    if (!root) throw new DomainError('not-found', 'Root not found');
    if (this.scanning) throw new DomainError('conflict', 'A scan is already running');
    const started = this.clock.now();
    const report: ScanReport = { rootId, scanned: 0, added: 0, updated: 0, removed: 0, skipped: [], durationMs: 0 };
    const abs = this.absoluteRootPath(root);
    const now = this.nowIso();
    if (!abs || !existsSync(abs)) {
      this.repo.updateRoot(rootId, { status: 'missing', lastScanAt: now, lastScanError: 'Directory not found' }, now);
      return report;
    }
    this.scanning = true;
    this.repo.updateRoot(rootId, { status: 'scanning', lastScanError: null }, now);
    const present = new Set<string>();
    try {
      const files = await this.walk(abs, abs, 0);
      for (const file of files) {
        const rel = relative(abs, file).split(sep).join('/');
        present.add(rel);
        report.scanned += 1;
        const ext = extname(file).toLowerCase();
        const mime = AUDIO_EXTENSIONS[ext];
        if (!mime) continue;
        try {
          const st = await stat(file);
          const existing = this.repo.findTrackByPath(rootId, rel);
          if (existing && existing.sizeBytes === st.size && existing.mtimeMs === Math.round(st.mtimeMs) && !existing.deletedAt) continue;
          const record = await this.buildRecord(root, file, rel, st.size, Math.round(st.mtimeMs), mime, existing);
          this.repo.upsertTrack(record, this.nowIso());
          if (existing && !existing.deletedAt) report.updated += 1;
          else report.added += 1;
          this.repo.updateRoot(rootId, { scanCheckpoint: JSON.stringify({ lastPath: rel, at: this.nowIso() }) }, this.nowIso());
        } catch (err) {
          report.skipped.push({ path: rel, reason: err instanceof Error ? err.message : String(err) });
          this.log.warn({ module: 'library', root: rootId, err: err instanceof Error ? err.message : String(err) }, 'file skipped');
        }
      }
      report.removed = this.repo.tombstoneMissing(rootId, present, this.nowIso());
      this.repo.updateRoot(rootId, { status: 'connected', lastScanAt: this.nowIso(), lastScanError: null, trackCount: this.repo.countTracks(rootId), scanCheckpoint: null }, this.nowIso());
      this.metrics.increment('library.scans');
      this.metrics.gauge('library.tracks', this.repo.countTracks());
    } catch (err) {
      this.repo.updateRoot(rootId, { status: 'error', lastScanAt: this.nowIso(), lastScanError: err instanceof Error ? err.message.slice(0, 500) : String(err) }, this.nowIso());
      throw err;
    } finally {
      this.scanning = false;
      this.indexDirty = true;
    }
    report.durationMs = this.clock.now() - started;
    return report;
  }

  private async walk(dir: string, rootAbs: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    const out: string[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow links out of the root
      if (entry.isDirectory()) out.push(...(await this.walk(full, rootAbs, depth + 1)));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }

  private async buildRecord(root: LibraryRoot, file: string, rel: string, sizeBytes: number, mtimeMs: number, mime: string, existing: HubTrackRecord | undefined): Promise<HubTrackRecord> {
    const contentHash = await hashFile(file);
    let title = rel.split('/').pop()!.replace(/\.[^.]+$/, '');
    let artistName = 'Unknown Artist';
    let albumName: string | null = null;
    let albumArtistName: string | null = null;
    let year: number | null = null;
    let genre: string | null = null;
    let durationMs: number | null = null;
    let trackNumber: number | null = null;
    let discNumber: number | null = null;
    let artworkId: string | null = null;
    let format: Track['format'] = { mime, sizeBytes };
    let unsupportedReason: string | null = BROWSER_DECODABLE.has(mime) ? null : `Browsers cannot decode ${mime}; convert to MP3/FLAC/Opus to play in the PWA`;
    try {
      const meta = await parseFile(file, { duration: true, skipPostHeaders: true });
      if (meta.common.title) title = meta.common.title;
      if (meta.common.artist) artistName = meta.common.artist;
      albumName = meta.common.album ?? null;
      albumArtistName = meta.common.albumartist ?? null;
      year = meta.common.year ?? null;
      genre = meta.common.genre?.[0] ?? null;
      durationMs = meta.format.duration ? Math.round(meta.format.duration * 1000) : null;
      trackNumber = meta.common.track.no ?? null;
      discNumber = meta.common.disk.no ?? null;
      format = { mime, sizeBytes, ...(meta.format.container ? { container: meta.format.container } : {}), ...(meta.format.codec ? { codec: meta.format.codec } : {}), ...(meta.format.sampleRate ? { sampleRateHz: meta.format.sampleRate } : {}), ...(meta.format.bitrate ? { bitrateKbps: Math.round(meta.format.bitrate / 1000) } : {}), ...(meta.format.numberOfChannels ? { channels: meta.format.numberOfChannels } : {}), ...(meta.format.lossless !== undefined ? { lossless: meta.format.lossless } : {}) };
      const picture = meta.common.picture?.[0];
      if (picture && /^image\/(png|jpeg|webp|gif)$/.test(picture.format)) artworkId = this.storeArtwork(picture.data, picture.format as Artwork['mime']);
    } catch (err) {
      if (!BROWSER_DECODABLE.has(mime)) unsupportedReason = `Unsupported or unreadable audio file (${err instanceof Error ? err.message : 'parse error'})`;
      else this.log.debug({ module: 'library', path: rel, err: err instanceof Error ? err.message : String(err) }, 'metadata parse failed; using filename');
    }
    const now = this.nowIso();
    const id = existing?.id ?? uuidv7(this.clock.now());
    const tag = root.handleId.startsWith(EXTERNAL_PREFIX) ? root.handleId.slice(EXTERNAL_PREFIX.length) : null;
    const track: Track = {
      id,
      schemaVersion: 1,
      createdAt: existing?.track.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      title,
      artistId: null,
      artistName,
      albumId: null,
      albumName,
      albumArtistName,
      discNumber,
      trackNumber,
      genre,
      genres: genre ? [genre] : [],
      tags: tag ? [tag] : [],
      year,
      durationMs,
      bpm: null,
      identity: { contentHash, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: { [tag === 'public-domain' ? 'public-domain' : 'hub']: [id] } },
      locators: [{ kind: 'hub-blob', hubId: this.hubId, blobId: contentHash }],
      artworkId,
      format,
      rootId: root.id,
      unsupportedReason,
      liked: false,
      explicit: null,
      popularity: null,
    };
    return { id, rootId: root.id, relativePath: rel, track, contentHash, sizeBytes, mtimeMs, mime, deletedAt: null };
  }

  private storeArtwork(data: Uint8Array, mime: Artwork['mime']): string {
    const hash = createHash('sha256').update(data).digest('hex');
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg';
    const id = `art_${hash.slice(0, 32)}`;
    const rel = `${id}.${ext}`;
    const abs = join(this.config.dataDir, 'artwork', rel);
    if (!existsSync(abs)) writeFileSync(abs, data);
    this.repo.putArtwork({ id, mime, width: 0, height: 0, sizeBytes: data.byteLength, relativePath: rel }, this.nowIso());
    return id;
  }

  /* ----------------------------------------------------------------- reads */

  findTrack(trackId: string): HubTrackRecord | undefined {
    const rec = this.repo.findTrack(trackId);
    return rec && !rec.deletedAt ? rec : undefined;
  }

  findByHash(contentHash: string): HubTrackRecord | undefined {
    return this.repo.findTracksByHash(contentHash)[0];
  }

  absolutePath(rec: HubTrackRecord): string | null {
    const root = this.repo.findRoot(rec.rootId);
    if (!root) return null;
    const base = this.absoluteRootPath(root);
    if (!base) return null;
    const abs = joinInsideRoot(base, rec.relativePath);
    return abs && existsSync(abs) ? abs : null;
  }

  tagOf(rec: HubTrackRecord): string | null {
    const root = this.repo.findRoot(rec.rootId);
    return root?.handleId.startsWith(EXTERNAL_PREFIX) ? root.handleId.slice(EXTERNAL_PREFIX.length) : null;
  }

  openRange(trackId: string, rangeHeader: string | undefined): RangeStream {
    const rec = this.findTrack(trackId);
    if (!rec) throw new DomainError('not-found', 'Track not found');
    const abs = this.absolutePath(rec);
    if (!abs) throw new DomainError('unavailable', 'The file for this track is not on disk');
    const size = statSync(abs).size;
    let start = 0;
    let end = size - 1;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!m) throw new DomainError('validation', 'Malformed Range header', { details: { status: 416 } });
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      if (!m[1] && m[2]) {
        start = Math.max(0, size - Number(m[2]));
        end = size - 1;
      }
      if (start > end || start >= size) throw new DomainError('validation', 'Range not satisfiable', { details: { status: 416, size } });
      end = Math.min(end, size - 1);
    }
    this.metrics.increment('library.streams');
    return { stream: createReadStream(abs, { start, end }), start, end, size, mime: rec.mime ?? 'application/octet-stream', filename: rec.relativePath.split('/').pop() ?? 'track' };
  }

  artworkPath(artworkId: string): { path: string; mime: string } | null {
    if (!/^art_[a-f0-9]{32}$/.test(artworkId)) return null;
    const art = this.repo.findArtwork(artworkId);
    if (!art) return null;
    const abs = joinInsideRoot(join(this.config.dataDir, 'artwork'), art.relativePath);
    return abs && existsSync(abs) ? { path: abs, mime: art.mime } : null;
  }

  private ensureIndex(): void {
    if (!this.indexDirty) return;
    const next = new LocalSearchIndex<IndexedHub>();
    for (const rec of this.repo.listTracks({})) {
      const t = rec.track;
      next.add({ id: rec.id, title: t.title, artistName: t.artistName, albumName: t.albumName, genre: t.genre, year: t.year, source: this.tagOf(rec) ?? 'hub' });
    }
    this.index = next;
    this.indexDirty = false;
  }

  search(query: string, options: { limit: number; tag?: string | null; excludeTag?: string | null; scope?: string }): HubTrackRecord[] {
    this.ensureIndex();
    const hits = this.index.search(query, { limit: Math.max(options.limit * 3, 50), ...(options.scope ? { scope: options.scope as never } : {}) });
    const out: HubTrackRecord[] = [];
    for (const hit of hits) {
      const rec = this.findTrack(hit.item.id);
      if (!rec) continue;
      const tag = this.tagOf(rec);
      if (options.tag !== undefined && options.tag !== null && tag !== options.tag) continue;
      if (options.excludeTag && tag === options.excludeTag) continue;
      out.push(rec);
      if (out.length >= options.limit) break;
    }
    return out;
  }

  listTracks(options: { q?: string | undefined; cursor?: string | undefined; limit: number; tag?: string | null }): { items: Track[]; nextCursor: string | null; total: number } {
    let records = options.q ? this.search(options.q, { limit: 5000, ...(options.tag !== undefined ? { tag: options.tag } : {}) }) : this.repo.listTracks({}).filter((r) => options.tag === undefined || options.tag === null || this.tagOf(r) === options.tag);
    if (!options.q) records = records.sort((a, b) => a.track.artistName.localeCompare(b.track.artistName) || (a.track.albumName ?? '').localeCompare(b.track.albumName ?? '') || (a.track.trackNumber ?? 0) - (b.track.trackNumber ?? 0));
    const offset = decodeCursor<{ offset: number }>(options.cursor)?.offset ?? 0;
    const page = records.slice(offset, offset + options.limit);
    const nextOffset = offset + options.limit;
    return { items: page.map((r) => r.track), nextCursor: nextOffset < records.length ? encodeCursor({ offset: nextOffset }) : null, total: records.length };
  }

  tracksForRoot(rootId: string): HubTrackRecord[] {
    return this.repo.listTracks({ rootId });
  }

  allTracks(): HubTrackRecord[] {
    return this.repo.listTracks({});
  }

  count(): number {
    return this.repo.countTracks();
  }

  streamPath(trackId: string): string {
    return routePath(routes.libraryStream, { trackId });
  }

  artworkPathFor(artworkId: string | null): string | null {
    return artworkId ? `${API_PREFIX}/library/artwork/${encodeURIComponent(artworkId)}` : null;
  }

  toTrackRef(rec: HubTrackRecord): TrackRef {
    const t = rec.track;
    const tag = this.tagOf(rec);
    return { trackId: t.id, title: t.title, artistName: t.artistName, albumName: t.albumName, durationMs: t.durationMs, artworkId: t.artworkId, identity: t.identity, locators: t.locators, provider: tag === 'public-domain' ? 'public-domain' : 'hub', genre: t.genre, year: t.year };
  }

  toSearchResult(rec: HubTrackRecord, provider: 'hub' | 'public-domain', capabilities: ProviderCapabilities, baseUrl: string): SearchResult {
    const t = rec.track;
    const r = buildResult({ provider, kind: 'track', providerId: t.id, title: t.title, artistName: t.artistName, albumName: t.albumName, durationMs: t.durationMs, artworkUrl: t.artworkId ? `${baseUrl}${this.artworkPathFor(t.artworkId)}` : null, canonicalUrl: null, year: t.year, genre: t.genre, capabilities: t.unsupportedReason ? { ...capabilities, playback: 'restricted', preview: 'restricted', reason: t.unsupportedReason } : capabilities, identity: t.identity, attribution: provider === 'public-domain' ? 'Synthetic fixture' : null, trackId: t.id, previewUrl: `${baseUrl}${this.streamPath(t.id)}` });
    return r;
  }

  maintenance(): void {
    this.repo.purgeTombstones(new Date(this.clock.now() - TOMBSTONE_RETENTION_MS).toISOString());
  }
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
