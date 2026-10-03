/**
 * When the next scheduled backup is due.
 *
 * Times are on the hub's own clock (the container's time zone, UTC unless `TZ` is set), because that
 * is the clock the operator's "every night at 03:00" is about. Days are stepped with the calendar,
 * not by adding 24 hours, so a change to or from summer time does not move the backup by an hour.
 */
import type { BackupSchedule } from '@now-playing/contracts';

/** The first scheduled moment strictly after `afterMs`, or null when backups are not scheduled. */
export function nextScheduledRun(schedule: BackupSchedule, afterMs: number): number | null {
  if (schedule.frequency === 'off') return null;
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
  const at = new Date(afterMs);
  const candidate = new Date(at.getFullYear(), at.getMonth(), at.getDate(), hours, minutes, 0, 0);
  if (schedule.frequency === 'daily') {
    if (candidate.getTime() <= afterMs) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  candidate.setDate(candidate.getDate() + ((schedule.weekday - candidate.getDay() + 7) % 7));
  if (candidate.getTime() <= afterMs) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}
