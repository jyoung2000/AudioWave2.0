import { HISTORY_CSV_COLUMNS, HISTORY_CSV_SCHEMA_VERSION, HistoryCsvRow as HistoryCsvRowSchema, type GroupHistoryEntry, type HistoryImportReport, type ListeningEvent } from '@now-playing/contracts';

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Neutralise spreadsheet formula injection by prefixing a single quote (documented in SECURITY.md). */
export function sanitizeFormula(cell: string): { value: string; sanitized: boolean } {
  if (FORMULA_PREFIX.test(cell)) return { value: `'${cell}`, sanitized: true };
  return { value: cell, sanitized: false };
}

export function stripFormulaSanitizer(cell: string): string {
  return cell.length > 1 && cell.startsWith("'") && FORMULA_PREFIX.test(cell.slice(1)) ? cell.slice(1) : cell;
}

export function encodeCsvCell(raw: string | number | null | undefined): string {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const { value } = sanitizeFormula(text);
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** RFC 4180: CRLF line endings, quoted fields where needed, header row first. */
export function encodeCsv(columns: readonly string[], rows: ReadonlyArray<Record<string, string | number | null | undefined>>): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => encodeCsvCell(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  errors: Array<{ row: number; message: string }>;
}

/** CSV parser (handles quotes, CRLF/LF, BOM). Row numbers are 1-based data rows. */
export function parseCsv(text: string, options: { maxRows?: number; maxBytes?: number } = {}): ParsedCsv {
  const maxRows = options.maxRows ?? 100_000;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  if (text.length > maxBytes) return { header: [], rows: [], errors: [{ row: 0, message: `CSV larger than ${maxBytes} bytes` }] };
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const errors: ParsedCsv['errors'] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      if (field.length === 0) inQuotes = true;
      else field += ch;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      record.push(field);
      field = '';
      if (record.length > 1 || record[0] !== '') records.push(record);
      record = [];
      if (records.length > maxRows + 1) {
        errors.push({ row: records.length, message: `More than ${maxRows} rows` });
        break;
      }
    } else field += ch;
  }
  if (inQuotes) errors.push({ row: records.length + 1, message: 'Unterminated quoted field' });
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }
  const header = records.shift() ?? [];
  return { header: header.map((h) => h.trim()), rows: records, errors };
}

export function historyEntryToCsvRow(entry: GroupHistoryEntry): Record<string, string | number> {
  return {
    schema_version: HISTORY_CSV_SCHEMA_VERSION,
    event_id: entry.id,
    group_id: entry.groupId,
    started_at_utc: entry.startedAt,
    ended_at_utc: entry.endedAt ?? '',
    track_id: entry.track.trackId,
    provider: entry.provider,
    provider_track_id: entry.providerTrackId ?? '',
    title: entry.track.title,
    artist: entry.track.artistName,
    album: entry.track.albumName ?? '',
    duration_ms: entry.track.durationMs ?? '',
    requester_id: entry.requesterId,
    requester_display_name: entry.requesterDisplayName,
    outcome: entry.outcome,
    skip_reason: entry.skipReason ?? '',
    queue_revision: entry.queueRevision,
  };
}

export function historyToCsv(entries: readonly GroupHistoryEntry[]): string {
  return encodeCsv(HISTORY_CSV_COLUMNS, entries.map(historyEntryToCsvRow));
}

export interface HistoryCsvParseResult {
  rows: Array<{ row: number; entry: GroupHistoryEntry }>;
  errors: Array<{ row: number; message: string }>;
  sanitizedCells: number;
  totalRows: number;
}

/** Validate headers, types and size; strip our own formula sanitizer on the way in. */
export function parseHistoryCsv(text: string, options: { maxRows?: number; maxBytes?: number } = {}): HistoryCsvParseResult {
  const parsed = parseCsv(text, options);
  const errors = [...parsed.errors];
  if (parsed.errors.some((e) => e.row === 0)) return { rows: [], errors, sanitizedCells: 0, totalRows: 0 };
  const missing = HISTORY_CSV_COLUMNS.filter((c) => !parsed.header.includes(c));
  if (missing.length) return { rows: [], errors: [{ row: 0, message: `Missing columns: ${missing.join(', ')}` }], sanitizedCells: 0, totalRows: parsed.rows.length };
  const unknown = parsed.header.filter((h) => !(HISTORY_CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) errors.push({ row: 0, message: `Ignored unknown columns: ${unknown.join(', ')}` });
  const idx = new Map(parsed.header.map((h, i) => [h, i]));
  const rows: HistoryCsvParseResult['rows'] = [];
  let sanitizedCells = 0;
  parsed.rows.forEach((cells, i) => {
    const rowNo = i + 1;
    const raw: Record<string, string> = {};
    for (const col of HISTORY_CSV_COLUMNS) {
      const v = cells[idx.get(col)!] ?? '';
      const stripped = stripFormulaSanitizer(v);
      if (stripped !== v) sanitizedCells += 1;
      raw[col] = stripped;
    }
    const result = HistoryCsvRowSchema.safeParse(raw);
    if (!result.success) {
      errors.push({ row: rowNo, message: result.error.issues.map((iss) => `${iss.path.join('.')}: ${iss.message}`).join('; ') });
      return;
    }
    const r = result.data;
    if (r.schema_version > HISTORY_CSV_SCHEMA_VERSION) {
      errors.push({ row: rowNo, message: `schema_version ${r.schema_version} is newer than supported ${HISTORY_CSV_SCHEMA_VERSION}` });
      return;
    }
    rows.push({
      row: rowNo,
      entry: {
        id: r.event_id,
        schemaVersion: HISTORY_CSV_SCHEMA_VERSION,
        groupId: r.group_id,
        startedAt: r.started_at_utc,
        endedAt: r.ended_at_utc === '' ? null : r.ended_at_utc,
        track: { trackId: r.track_id, title: r.title, artistName: r.artist, albumName: r.album || null, durationMs: r.duration_ms === '' ? null : r.duration_ms, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: r.provider_track_id ? { [r.provider]: [r.provider_track_id] } : {} }, locators: [], provider: r.provider, genre: null, year: null },
        provider: r.provider,
        providerTrackId: r.provider_track_id || null,
        requesterId: r.requester_id,
        requesterDisplayName: r.requester_display_name,
        outcome: r.outcome,
        skipReason: r.skip_reason || null,
        queueRevision: r.queue_revision,
      },
    });
  });
  return { rows, errors, sanitizedCells, totalRows: parsed.rows.length };
}

/** Idempotent import plan: rows whose event_id already exists (or repeats within the file) are skipped. */
export function planHistoryImport(parsed: HistoryCsvParseResult, existingIds: ReadonlySet<string>, groupId: string, dryRun: boolean): { report: HistoryImportReport; toInsert: GroupHistoryEntry[] } {
  const seen = new Set<string>();
  const toInsert: GroupHistoryEntry[] = [];
  let skipped = 0;
  const errors = [...parsed.errors];
  for (const { row, entry } of parsed.rows) {
    if (entry.groupId !== groupId) {
      errors.push({ row, message: `group_id ${entry.groupId} does not match the target group` });
      continue;
    }
    if (existingIds.has(entry.id) || seen.has(entry.id)) {
      skipped += 1;
      continue;
    }
    seen.add(entry.id);
    toInsert.push(entry);
  }
  return { report: { dryRun, totalRows: parsed.totalRows, accepted: toInsert.length, skipped, errors: errors.slice(0, 500), sanitizedCells: parsed.sanitizedCells }, toInsert };
}

/**
 * Column order of the personal listening-history export.
 *
 * This is a *different* export from the group history above: it covers one person's own events on
 * one device, including the reasons and completion figures the metrics are computed from. Keeping
 * the two separate means neither has to carry the other's columns as blanks.
 */
export const LISTENING_CSV_COLUMNS = [
  'schema_version',
  'event_id',
  'occurred_at_utc',
  'type',
  'session_id',
  'device_id',
  'mode',
  'track_id',
  'title',
  'artist',
  'album',
  'genre',
  'year',
  'duration_ms',
  'provider',
  'position_ms',
  'seconds_played',
  'completion_percent',
  'reason',
  'playlist_id',
  'preset_id',
  'context_kind',
  'context_id',
] as const;
export type ListeningCsvColumn = (typeof LISTENING_CSV_COLUMNS)[number];

export function listeningEventToCsvRow(event: ListeningEvent): Record<string, string | number> {
  return {
    schema_version: event.schemaVersion,
    event_id: event.id,
    occurred_at_utc: event.occurredAt,
    type: event.type,
    session_id: event.sessionId,
    device_id: event.deviceId,
    mode: event.mode,
    track_id: event.trackId ?? '',
    title: event.track?.title ?? '',
    artist: event.track?.artistName ?? '',
    album: event.track?.albumName ?? '',
    genre: event.track?.genre ?? '',
    year: event.track?.year ?? '',
    duration_ms: event.track?.durationMs ?? '',
    provider: event.track?.provider ?? '',
    position_ms: event.positionMs ?? '',
    seconds_played: event.secondsPlayed ?? '',
    completion_percent: event.completionPercent ?? '',
    reason: event.reason ?? '',
    playlist_id: event.playlistId ?? '',
    preset_id: event.presetId ?? '',
    context_kind: event.contextKind ?? '',
    context_id: event.contextId ?? '',
  };
}

/** RFC-4180 CSV of a person's own listening events, safe to open in a spreadsheet. */
export function listeningEventsToCsv(events: readonly ListeningEvent[]): string {
  return encodeCsv(LISTENING_CSV_COLUMNS, events.map(listeningEventToCsvRow));
}
