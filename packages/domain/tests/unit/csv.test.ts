import { describe, expect, it } from 'vitest';
import type { GroupHistoryEntry } from '@now-playing/contracts';
import { encodeCsv, historyToCsv, parseCsv, parseHistoryCsv, planHistoryImport, sanitizeFormula } from '../../src/csv.js';

const G = '0192b1f0-0000-7000-8000-00000000aaaa';
const entry = (n: number, title = `Song ${n}`): GroupHistoryEntry => ({ id: `0192b1f0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`, schemaVersion: 1, groupId: G, startedAt: '2026-09-03T12:00:00.000Z', endedAt: '2026-09-03T12:03:00.000Z', track: { trackId: `0192b1f0-0000-7000-8000-00000000ff${String(n).padStart(2, '0')}`, title, artistName: 'Artist, "The"', albumName: 'Album', durationMs: 180000, artworkId: null, identity: { contentHash: null, quickHash: null, isrc: null, musicbrainzRecordingId: null, musicbrainzReleaseId: null, acoustidId: null, providerIds: {} }, locators: [], provider: 'local', genre: null, year: null }, provider: 'local', providerTrackId: null, requesterId: 'alice', requesterDisplayName: 'Alice', outcome: 'completed', skipReason: null, queueRevision: n });

describe('csv', () => {
  it('encodes RFC 4180 with CRLF and quoting', () => {
    const out = encodeCsv(['a', 'b'], [{ a: 'x,y', b: 'he said "hi"' }, { a: 'line\nbreak', b: null }]);
    expect(out).toBe('a,b\r\n"x,y","he said ""hi"""\r\n"line\nbreak",\r\n');
  });
  it('parses quotes, CRLF, BOM', () => {
    const p = parseCsv('\ufeffa,b\r\n"x,y","he said ""hi"""\r\n"line\nbreak",\r\n');
    expect(p.header).toEqual(['a', 'b']);
    expect(p.rows).toEqual([['x,y', 'he said "hi"'], ['line\nbreak', '']]);
    expect(parseCsv('a,b\n"unterminated').errors).toHaveLength(1);
  });
  it('sanitizes formula prefixes and restores them on import', () => {
    expect(sanitizeFormula('=SUM(A1)')).toEqual({ value: "'=SUM(A1)", sanitized: true });
    const csv = historyToCsv([entry(1, '=HYPERLINK("x")')]);
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    const parsed = parseHistoryCsv(csv);
    expect(parsed.rows[0]!.entry.track.title).toBe('=HYPERLINK("x")');
    expect(parsed.sanitizedCells).toBe(1);
  });
  it('round-trips history and is idempotent', () => {
    const entries = [entry(1), entry(2)];
    const csv = historyToCsv(entries);
    const parsed = parseHistoryCsv(csv);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.rows.map((r) => r.entry)).toMatchObject(entries.map((e) => ({ id: e.id, track: { title: e.track.title, artistName: e.track.artistName } })));
    const plan = planHistoryImport(parsed, new Set([entries[0]!.id]), G, false);
    expect(plan.report.accepted).toBe(1);
    expect(plan.report.skipped).toBe(1);
    const dup = parseHistoryCsv(historyToCsv([entry(3), entry(3)]));
    expect(planHistoryImport(dup, new Set(), G, true).report).toMatchObject({ accepted: 1, skipped: 1, dryRun: true });
  });
  it('rejects bad headers, types, wrong group and newer schema', () => {
    expect(parseHistoryCsv('a,b\r\n1,2\r\n').errors[0]!.message).toContain('Missing columns');
    const csv = historyToCsv([entry(1)]).replace('completed', 'exploded');
    expect(parseHistoryCsv(csv).errors[0]!.message).toContain('outcome');
    const newer = historyToCsv([entry(1)]).replace(/\r\n1,/, '\r\n99,');
    expect(parseHistoryCsv(newer).errors[0]!.message).toContain('newer');
    const wrongGroup = planHistoryImport(parseHistoryCsv(historyToCsv([entry(1)])), new Set(), '0192b1f0-0000-7000-8000-00000000bbbb', false);
    expect(wrongGroup.report.errors[0]!.message).toContain('does not match');
  });
  it('enforces size limits', () => {
    expect(parseCsv('a'.repeat(10), { maxBytes: 5 }).errors[0]!.row).toBe(0);
  });
});
