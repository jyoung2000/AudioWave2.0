export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function parseIso(value: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Invalid ISO timestamp: ${value}`);
  return t;
}

export function compareIso(a: string, b: string): number {
  return parseIso(a) - parseIso(b);
}

export function addMs(iso: string, ms: number): string {
  return new Date(parseIso(iso) + ms).toISOString();
}

/** m:ss or h:mm:ss. Negative values are prefixed with "-". Rounds to the nearest second. */
export function formatDuration(ms: number | null | undefined, options: { alwaysHours?: boolean } = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--';
  const sign = ms < 0 ? '-' : '';
  const total = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 || options.alwaysHours ? String(m).padStart(2, '0') : String(m);
  const body = h > 0 || options.alwaysHours ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
  return sign + body;
}

/** "3 hours, 12 minutes" style totals for status bars. */
export function formatTotalDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (!parts.length) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.slice(0, 2).join(', ');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Local time formatting (UTC storage, local display). */
export function formatLocalDateTime(iso: string, locale?: string, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat(locale, opts).format(new Date(parseIso(iso)));
}

export function decadeOf(year: number | null | undefined): string | null {
  if (!year || !Number.isFinite(year)) return null;
  return `${Math.floor(year / 10) * 10}s`;
}

/** ISO week key like 2026-W36 (UTC). */
export function isoWeekKey(iso: string): string {
  const d = new Date(parseIso(iso));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}
