/**
 * The companion's log: what it did, written to `<data>\logs\companion.log` so there is something to
 * look at — and to send — when a download fails or the helper will not start.
 *
 * Lines are appended as they happen and the file is rolled over at a megabyte, keeping three old
 * ones, so a companion left running for months holds a few megabytes of log and no more. "Detailed
 * logs" (Settings ▸ Storage and privacy) adds the debug lines; without it they are dropped.
 *
 * Nothing secret is meant to reach a log in the first place — the helper token, the hub credential
 * and the streaming key are never logged — but Export Logs does not rely on that: every line goes
 * through `redactLog` on the way into the zip, which takes out the secrets this companion holds,
 * anything shaped like a token, and folder paths.
 *
 * Nothing here touches Electron, so the tests drive it against a temporary folder.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '@now-playing/domain/tool-install';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_FILE = 'companion.log';
const MAX_BYTES = 1024 * 1024;
const KEEP = 3;

export class Log {
  private verbose = false;
  private failed = false;

  constructor(
    readonly dir: string,
    private readonly options: { maxBytes?: number; keep?: number; now?: () => Date } = {},
  ) {}

  setVerbose(verbose: boolean): void {
    if (verbose !== this.verbose) {
      this.verbose = verbose;
      this.write('info', verbose ? 'Detailed logs are on.' : 'Detailed logs are off.');
    }
  }

  get isVerbose(): boolean {
    return this.verbose;
  }

  debug(message: string): void {
    if (this.verbose) this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  /** The log files, newest first: `companion.log`, then `companion.1.log` and so on. */
  files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => /^companion(\.\d+)?\.log$/.test(name))
      .sort((a, b) => order(a) - order(b))
      .map((name) => join(this.dir, name));
  }

  private write(level: LogLevel, message: string): void {
    if (this.failed) return;
    const at = (this.options.now?.() ?? new Date()).toISOString();
    const line = `${at} ${level.toUpperCase().padEnd(5)} ${message.replace(/\r?\n/g, ' ⏎ ')}\n`;
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, LOG_FILE);
      if (existsSync(file) && statSync(file).size + line.length > (this.options.maxBytes ?? MAX_BYTES)) this.roll();
      appendFileSync(file, line, 'utf8');
    } catch {
      // A log that cannot be written must never stop the app; it stops trying instead.
      this.failed = true;
    }
  }

  private roll(): void {
    const keep = this.options.keep ?? KEEP;
    rmSync(join(this.dir, `companion.${keep}.log`), { force: true });
    for (let i = keep - 1; i >= 1; i -= 1) {
      const from = join(this.dir, `companion.${i}.log`);
      if (existsSync(from)) renameSync(from, join(this.dir, `companion.${i + 1}.log`));
    }
    renameSync(join(this.dir, LOG_FILE), join(this.dir, 'companion.1.log'));
  }
}

function order(name: string): number {
  const match = /^companion\.(\d+)\.log$/.exec(name);
  return match ? Number(match[1]) : 0;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A log line with nothing in it that should leave this PC:
 *
 * - each secret the companion holds right now (helper token, hub credential), wherever it appears;
 * - anything after `Bearer`, and `token=`, `secret=`, `key=` and `password=` values;
 * - long hex and base64url runs, which is what keys and tokens look like;
 * - the home folder, and the folders in any Windows or POSIX path (the file name is kept).
 */
export function redactLog(text: string, secrets: readonly string[] = [], home: string = homedir()): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[secret]');
  }
  out = out
    .replace(/\b(Bearer)\s+[^\s"']+/gi, '$1 [secret]')
    .replace(/\b(token|secret|key|password|credential|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2[secret]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[secret]')
    .replace(/(?<![\w/\\.-])[A-Za-z0-9_-]{32,}(?![\w/\\.-])/g, (run) => (/[0-9]/.test(run) && /[A-Za-z]/.test(run) ? '[secret]' : run));
  if (home && home.length > 3) {
    for (const spelling of new Set([home, home.replace(/\\/g, '/')])) out = out.replace(new RegExp(escape(spelling), 'gi'), '~');
  }
  return out
    .replace(/\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|:*?]+[\\/])+/g, '…\\')
    .replace(/\\\\[^\\/\s"']+\\(?:[^\\/\s"']+\\)*/g, '…\\')
    .replace(/(^|[\s"'=(])\/(?:[^/\s"']+\/)+/g, '$1…/')
    .replace(/~[\\/](?:[^\\/\s"'<>|:*?]+[\\/])+/g, '~\\…\\');
}

/** One file in a zip: its name inside the archive and its bytes. */
export interface ZipItem {
  name: string;
  data: Buffer;
}

/**
 * A .zip of the items, deflated, written by hand: the format is small and fixed, and the companion
 * already carries the CRC-32 its tool installer checks zips with. Names are kept to plain
 * characters so Explorer opens it without asking about an encoding.
 */
export function zipFiles(items: readonly ZipItem[], now: Date = new Date()): Buffer {
  const time = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor(now.getSeconds() / 2) & 31);
  const date = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name.replace(/[^\w.\- ]/g, '_'), 'utf8');
    const packed = deflateRawSync(item.data);
    const crc = crc32(item.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(item.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(item.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Writes the logs, redacted, into a zip at `target`. Returns how many log files went in. */
export function exportLogs(log: Log, target: string, secrets: readonly string[], extra: ZipItem[] = []): number {
  const files = log.files();
  const items: ZipItem[] = files.map((file) => ({ name: basename(file), data: Buffer.from(redactLog(readFileSync(file, 'utf8'), secrets), 'utf8') }));
  writeFileSync(target, zipFiles([...items, ...extra.map((item) => ({ name: item.name, data: Buffer.from(redactLog(item.data.toString('utf8'), secrets), 'utf8') }))]));
  return files.length;
}
