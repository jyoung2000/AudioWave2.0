/**
 * Profiles: a username, a picture and shared playlists for the HubUser behind a device credential.
 *
 * Three things here are decided by the server and not by what the client sent:
 *
 *  - A username is unique per hub, compared case-insensitively after NFC normalisation. The check in
 *    code is a courtesy; the unique index on `hub_users.profile_name_key` is the rule, so two saves
 *    racing each other cannot both win.
 *  - A picture is never stored as uploaded. The bytes have to really be PNG, JPEG or WebP (magic
 *    numbers, not the Content-Type header), and are re-encoded to a 256 × 256 WebP with the metadata
 *    dropped. A hub whose FFmpeg cannot do that refuses the upload rather than keeping the original.
 *  - A playlist is parsed and stored normalised, and served re-serialised. The uploaded bytes are
 *    never echoed, and cells lose a leading `=`, `+`, `-` or `@` on the way out so a shared playlist
 *    opened in a spreadsheet cannot run a formula.
 */
import { spawn } from 'node:child_process';
import { API_PREFIX, ProfileName, type ProfileAdminView, type ProfileSummary, type ProfileView } from '@now-playing/contracts';
import { DomainError, parseCsv, uuidv7 } from '@now-playing/domain';
import type { AuditService } from '../auth/audit.js';
import type { Db } from '../db/connection.js';
import type { Clock, FfmpegInfo } from '../deps.js';
import type { MetricsRegistry } from '../metrics/registry.js';

export const AVATAR_MAX_BYTES = 1024 * 1024;
export const AVATAR_MAX_DIMENSION = 512;
export const AVATAR_STORED_SIZE = 256;
export const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
export const PLAYLIST_MAX_ROWS = 5000;
export const PLAYLIST_COLUMNS = ['title', 'artist', 'album', 'seconds'] as const;

const RESERVED_NAME_KEYS = new Set(['admin']);

export type ImageKind = 'png' | 'jpeg' | 'webp';
export interface SniffedImage {
  kind: ImageKind;
  width: number;
  height: number;
}

/** Where a request came from, for the audit trail. */
export interface ProfileMeta {
  ip?: string | null;
  correlationId?: string | null;
}

export interface ProfileActor {
  kind: 'device' | 'admin';
  id: string;
  displayName: string;
}

interface UserRow {
  id: string;
  display_name: string;
  profile_name_key: string | null;
  avatar: string | null;
  updated_at: string;
}

/** The form two names are compared in: NFC, trimmed, inner whitespace collapsed, lower-cased. */
export function profileNameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** What kind of image these bytes really are, and how big — or null when they are none of the three. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { kind: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      // Start-of-frame markers carry the dimensions; C4, C8 and CC are tables, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { kind: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { kind: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { kind: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return null;
}

/** Drop what would make a spreadsheet treat the cell as a formula. */
export function stripFormulaLead(cell: string): string {
  let out = cell;
  while (/^\s*[=+\-@]/.test(out) || /^[\t\r]/.test(out)) out = out.replace(/^[\s=+\-@]+/, '');
  return out;
}

function csvCell(value: string): string {
  const safe = stripFormulaLead(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface PlaylistRow {
  title: string;
  artist: string;
  album: string;
  seconds: number;
}

/** Parse an uploaded playlist. Throws a validation error naming the first thing wrong with it. */
export function parsePlaylistCsv(text: string): PlaylistRow[] {
  if (Buffer.byteLength(text, 'utf8') > PLAYLIST_MAX_BYTES) throw new DomainError('validation', 'A shared playlist may be at most 2 MB');
  const parsed = parseCsv(text, { maxRows: PLAYLIST_MAX_ROWS, maxBytes: PLAYLIST_MAX_BYTES });
  const tooMany = (): DomainError => new DomainError('validation', `A shared playlist may have at most ${PLAYLIST_MAX_ROWS} rows`);
  if (parsed.errors.length) throw parsed.errors[0]!.message.startsWith('More than') ? tooMany() : new DomainError('validation', `This is not a readable CSV: ${parsed.errors[0]!.message}`);
  const header = parsed.header.map((h) => h.toLowerCase());
  if (header.length !== PLAYLIST_COLUMNS.length || PLAYLIST_COLUMNS.some((c, i) => header[i] !== c)) throw new DomainError('validation', `The first line must be ${PLAYLIST_COLUMNS.join(',')}`);
  if (parsed.rows.length > PLAYLIST_MAX_ROWS) throw tooMany();
  return parsed.rows.map((cells, i) => {
    const seconds = Number((cells[3] ?? '').trim() || '0');
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 3600) throw new DomainError('validation', `Row ${i + 1}: seconds must be a number between 0 and 86400`);
    const text = (n: number): string => (cells[n] ?? '').trim().slice(0, 300);
    if (!text(0)) throw new DomainError('validation', `Row ${i + 1}: a title is needed`);
    return { title: text(0), artist: text(1), album: text(2), seconds: Math.round(seconds) };
  });
}

export function serializePlaylistCsv(rows: readonly PlaylistRow[]): string {
  const lines = [PLAYLIST_COLUMNS.join(',')];
  for (const r of rows) lines.push([csvCell(r.title), csvCell(r.artist), csvCell(r.album), String(r.seconds)].join(','));
  return lines.join('\r\n') + '\r\n';
}

export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly ffmpeg: () => Promise<FfmpegInfo>,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    private readonly clock: Clock,
  ) {}

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private row(userId: string): UserRow {
    const r = this.db.prepare<[string], UserRow>('SELECT id, display_name, profile_name_key, avatar, updated_at FROM hub_users WHERE id = ? AND deleted_at IS NULL').get(userId);
    if (!r) throw new DomainError('not-found', 'No such profile');
    return r;
  }

  private avatarUrl(r: Pick<UserRow, 'id' | 'avatar'>): string | null {
    return r.avatar?.includes('"image"') ? `${API_PREFIX}/profiles/${r.id}/avatar` : null;
  }

  view(userId: string): ProfileView {
    const r = this.row(userId);
    const playlists = this.db
      .prepare<[string], { playlist_id: string; name: string; tracks: number; updated_at: string }>('SELECT playlist_id, name, tracks, updated_at FROM profile_playlists WHERE user_id = ? ORDER BY name COLLATE NOCASE, playlist_id')
      .all(userId)
      .map((p) => ({ id: p.playlist_id, name: p.name, tracks: p.tracks, updatedAt: p.updated_at }));
    return { id: r.id, displayName: r.display_name, avatarUrl: this.avatarUrl(r), playlists };
  }

  /** The name a directed invite shows for its addressee; null when the profile is gone. */
  displayName(userId: string): string | null {
    return this.db.prepare<[string], { display_name: string }>('SELECT display_name FROM hub_users WHERE id = ? AND deleted_at IS NULL').get(userId)?.display_name ?? null;
  }

  private summary(r: UserRow & { playlist_count: number }): ProfileSummary {
    return { id: r.id, displayName: r.display_name, avatarUrl: this.avatarUrl(r), playlistCount: r.playlist_count };
  }

  /** Free for `userId` to take: well-formed, not reserved, and not held by anyone else. */
  available(name: string, userId: string | null): boolean {
    const parsed = ProfileName.safeParse(name);
    if (!parsed.success) return false;
    const key = profileNameKey(parsed.data);
    if (RESERVED_NAME_KEYS.has(key)) return false;
    const holder = this.db.prepare<[string], { id: string }>('SELECT id FROM hub_users WHERE profile_name_key = ?').get(key);
    return !holder || holder.id === userId;
  }

  rename(userId: string, name: string, actor: ProfileActor, meta: ProfileMeta = {}): ProfileView {
    this.row(userId);
    const displayName = name.normalize('NFC').trim().replace(/\s+/g, ' ');
    const key = profileNameKey(displayName);
    const taken = (): DomainError => new DomainError('conflict', 'That name is taken', { details: { reason: 'name-taken' } });
    if (RESERVED_NAME_KEYS.has(key)) throw taken();
    try {
      this.db.prepare('UPDATE hub_users SET display_name = ?, profile_name_key = ?, updated_at = ? WHERE id = ?').run(displayName, key, this.nowIso(), userId);
    } catch (err) {
      if (typeof (err as { code?: unknown }).code === 'string' && (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')) throw taken();
      throw err;
    }
    this.audit.record({ actor, action: 'profile.rename', target: { kind: 'profile', id: userId }, outcome: 'success', ip: meta.ip ?? null, correlationId: meta.correlationId ?? null });
    this.metrics.increment('profiles.renames');
    return this.view(userId);
  }

  async putAvatar(userId: string, bytes: Uint8Array, actor: ProfileActor, meta: ProfileMeta = {}): Promise<void> {
    this.row(userId);
    if (bytes.byteLength === 0) throw new DomainError('validation', 'Send the picture as the request body');
    if (bytes.byteLength > AVATAR_MAX_BYTES) throw new DomainError('validation', 'A picture may be at most 1 MB');
    const sniffed = sniffImage(bytes);
    if (!sniffed) throw new DomainError('validation', 'The picture must be a PNG, JPEG or WebP image');
    if (sniffed.width < 1 || sniffed.height < 1 || sniffed.width > AVATAR_MAX_DIMENSION || sniffed.height > AVATAR_MAX_DIMENSION) throw new DomainError('validation', `A picture may be at most ${AVATAR_MAX_DIMENSION} × ${AVATAR_MAX_DIMENSION} pixels`);
    const webp = await this.reencode(bytes, sniffed.kind);
    const out = sniffImage(webp);
    if (!out || out.kind !== 'webp') throw new DomainError('unavailable', 'This hub could not process the picture');
    const now = this.nowIso();
    const blobId = uuidv7(this.clock.now());
    const avatar = JSON.stringify({ kind: 'image', blobId, mime: 'image/webp', width: out.width, height: out.height });
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM profile_avatars WHERE user_id = ?').run(userId);
      this.db.prepare('INSERT INTO profile_avatars (blob_id, user_id, bytes, created_at) VALUES (?, ?, ?, ?)').run(blobId, userId, webp, now);
      this.db.prepare('UPDATE hub_users SET avatar = ?, updated_at = ? WHERE id = ?').run(avatar, now, userId);
    })();
    this.audit.record({ actor, action: 'profile.avatar.set', target: { kind: 'profile', id: userId }, outcome: 'success', ip: meta.ip ?? null, correlationId: meta.correlationId ?? null, details: { sourceKind: sniffed.kind, storedBytes: webp.byteLength } });
  }

  removeAvatar(userId: string, actor: ProfileActor, meta: ProfileMeta = {}): void {
    this.row(userId);
    const now = this.nowIso();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM profile_avatars WHERE user_id = ?').run(userId);
      this.db.prepare('UPDATE hub_users SET avatar = NULL, updated_at = ? WHERE id = ?').run(now, userId);
    })();
    this.audit.record({ actor, action: 'profile.avatar.remove', target: { kind: 'profile', id: userId }, outcome: 'success', ip: meta.ip ?? null, correlationId: meta.correlationId ?? null });
  }

  avatarBytes(userId: string): Buffer {
    const r = this.db.prepare<[string], { bytes: Buffer }>('SELECT bytes FROM profile_avatars WHERE user_id = ?').get(userId);
    if (!r) throw new DomainError('not-found', 'This profile has no picture');
    return r.bytes;
  }

  putPlaylist(userId: string, playlistId: string, name: string, csv: string): void {
    this.row(userId);
    const rows = parsePlaylistCsv(csv);
    this.db
      .prepare('INSERT INTO profile_playlists (user_id, playlist_id, name, csv, tracks, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, playlist_id) DO UPDATE SET name = excluded.name, csv = excluded.csv, tracks = excluded.tracks, updated_at = excluded.updated_at')
      .run(userId, playlistId, name, serializePlaylistCsv(rows), rows.length, this.nowIso());
    this.metrics.increment('profiles.playlists_shared');
  }

  removePlaylist(userId: string, playlistId: string): void {
    this.db.prepare('DELETE FROM profile_playlists WHERE user_id = ? AND playlist_id = ?').run(userId, playlistId);
  }

  /** Parsed and written out again on every read, so what is served never depends on what was stored. */
  playlistCsv(userId: string, playlistId: string): string {
    const r = this.db.prepare<[string, string], { csv: string }>('SELECT csv FROM profile_playlists WHERE user_id = ? AND playlist_id = ?').get(userId, playlistId);
    if (!r) throw new DomainError('not-found', 'No such shared playlist');
    return serializePlaylistCsv(parsePlaylistCsv(r.csv));
  }

  search(q: string, limit: number, excludeUserId: string): ProfileSummary[] {
    const needle = profileNameKey(q).replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db
      .prepare<[string, string, number], UserRow & { playlist_count: number }>(
        "SELECT u.id, u.display_name, u.profile_name_key, u.avatar, u.updated_at, (SELECT COUNT(*) FROM profile_playlists p WHERE p.user_id = u.id) AS playlist_count FROM hub_users u WHERE u.deleted_at IS NULL AND u.id <> ? AND lower(u.display_name) LIKE '%' || ? || '%' ESCAPE '\\' ORDER BY u.display_name COLLATE NOCASE LIMIT ?",
      )
      .all(excludeUserId, needle, limit)
      .map((r) => this.summary(r));
  }

  listAll(): ProfileAdminView[] {
    return this.db
      .prepare<[], UserRow & { playlist_count: number }>('SELECT u.id, u.display_name, u.profile_name_key, u.avatar, u.updated_at, (SELECT COUNT(*) FROM profile_playlists p WHERE p.user_id = u.id) AS playlist_count FROM hub_users u WHERE u.deleted_at IS NULL ORDER BY u.display_name COLLATE NOCASE')
      .all()
      .map((r) => ({ ...this.summary(r), claimed: r.profile_name_key !== null, updatedAt: r.updated_at }));
  }

  adminView(userId: string): ProfileAdminView {
    const found = this.listAll().find((p) => p.id === userId);
    if (!found) throw new DomainError('not-found', 'No such profile');
    return found;
  }

  /** Re-encode through FFmpeg: square-cropped to 256 × 256, metadata dropped, WebP out. */
  private async reencode(bytes: Uint8Array, kind: ImageKind): Promise<Buffer> {
    const info = await this.ffmpeg();
    if (!info.available || !info.path) throw new DomainError('unavailable', 'This hub cannot process pictures: FFmpeg is not available');
    const size = AVATAR_STORED_SIZE;
    const args = ['-hide_banner', '-loglevel', 'error', '-f', `${kind}_pipe`, '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`, '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '82', '-f', 'webp', 'pipe:1'];
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(info.path!, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const chunks: Buffer[] = [];
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-400)));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new DomainError('unavailable', 'This hub cannot process pictures: FFmpeg did not start', { cause: err }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks);
        if (code === 0 && out.byteLength > 0) return resolve(out);
        const noEncoder = /libwebp|Unknown encoder/i.test(stderr);
        reject(new DomainError(noEncoder ? 'unavailable' : 'validation', noEncoder ? 'This hub cannot process pictures: its FFmpeg has no WebP encoder' : 'The picture could not be read'));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    });
  }
}
