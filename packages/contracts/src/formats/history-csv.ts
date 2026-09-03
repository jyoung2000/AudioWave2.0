import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../common.js';

/** Column order of the RFC-4180 group history export. */
export const HISTORY_CSV_COLUMNS = [
  'schema_version',
  'event_id',
  'group_id',
  'started_at_utc',
  'ended_at_utc',
  'track_id',
  'provider',
  'provider_track_id',
  'title',
  'artist',
  'album',
  'duration_ms',
  'requester_id',
  'requester_display_name',
  'outcome',
  'skip_reason',
  'queue_revision',
] as const;
export type HistoryCsvColumn = (typeof HISTORY_CSV_COLUMNS)[number];

export const HistoryCsvRow = z.object({
  schema_version: z.coerce.number().int().positive(),
  event_id: z.uuid(),
  group_id: z.uuid(),
  started_at_utc: z.iso.datetime({ offset: true }),
  ended_at_utc: z.union([z.iso.datetime({ offset: true }), z.literal('')]),
  track_id: z.uuid(),
  provider: z.string().min(1).max(32),
  provider_track_id: z.string().max(200),
  title: z.string().min(1).max(300),
  artist: z.string().min(1).max(300),
  album: z.string().max(300),
  duration_ms: z.union([z.coerce.number().int().nonnegative(), z.literal('')]),
  requester_id: z.string().min(1).max(200),
  requester_display_name: z.string().max(120),
  outcome: z.enum(['completed', 'skipped', 'failed', 'stopped', 'unavailable', 'playing']),
  skip_reason: z.string().max(120),
  queue_revision: z.coerce.number().int().nonnegative(),
});
export type HistoryCsvRow = z.infer<typeof HistoryCsvRow>;

export const HISTORY_CSV_SCHEMA_VERSION = SCHEMA_VERSIONS.historyCsv;

export const HistoryImportReport = z.object({
  dryRun: z.boolean(),
  totalRows: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative().describe('Duplicates by event_id'),
  errors: z.array(z.object({ row: z.number().int().positive(), message: z.string() })).max(500),
  sanitizedCells: z.number().int().nonnegative().describe('Cells whose spreadsheet-formula prefix was neutralised'),
});
export type HistoryImportReport = z.infer<typeof HistoryImportReport>;
