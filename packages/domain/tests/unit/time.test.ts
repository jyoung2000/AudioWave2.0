import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatTotalDuration, isoWeekKey, decadeOf } from '../../src/time.js';

describe('time formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(-65_000)).toBe('-1:05');
    expect(formatDuration(null)).toBe('--:--');
    expect(formatDuration(59_600)).toBe('1:00');
  });
  it('formats totals and bytes', () => {
    expect(formatTotalDuration(3 * 3_600_000 + 12 * 60_000)).toBe('3 hours, 12 minutes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
  });
  it('week keys and decades', () => {
    expect(isoWeekKey('2026-01-01T00:00:00.000Z')).toBe('2026-W01');
    expect(decadeOf(1994)).toBe('1990s');
    expect(decadeOf(null)).toBeNull();
  });
});
