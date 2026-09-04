import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import { redactSecrets } from '@now-playing/domain';
import { RingBuffer, type LogLine } from './ring-buffer.js';
import { RotatingFile } from './rotating-file.js';

export const LOG_RING_CAPACITY = 2000;

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["sec-websocket-protocol"]',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'secret',
  'claimSecret',
  'clientSecret',
  'apiKey',
  'code',
  'inviteCode',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.token',
  '*.secret',
  '*.clientSecret',
  '*.apiKey',
  '*.claimSecret',
  '*.accessToken',
  '*.refreshToken',
];

export interface HubLogging {
  logger: Logger;
  ring: RingBuffer<LogLine>;
  file: RotatingFile | null;
}

const LEVEL_NAMES: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export function parseLogLine(raw: string): LogLine | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const { time, level, msg, correlationId, module, pid: _pid, hostname: _host, ...rest } = obj;
    const levelName = typeof level === 'number' ? (LEVEL_NAMES[level] ?? String(level)) : String(level ?? 'info');
    return {
      time: typeof time === 'number' ? new Date(time).toISOString() : typeof time === 'string' ? time : new Date().toISOString(),
      level: levelName,
      msg: typeof msg === 'string' ? msg : '',
      correlationId: typeof correlationId === 'string' ? correlationId : null,
      module: typeof module === 'string' ? module : null,
      data: redactSecrets(rest),
    };
  } catch {
    return null;
  }
}

export interface LoggerOptions {
  level: string;
  logDir: string | null;
  stdout: boolean;
  pretty?: boolean;
}

/** pino with redaction, a 2000-line ring buffer and a size-rotated file (5 × 5 MiB). */
export function createHubLogging(options: LoggerOptions): HubLogging {
  const ring = new RingBuffer<LogLine>(LOG_RING_CAPACITY);
  const file = options.logDir ? new RotatingFile({ dir: options.logDir, baseName: 'hub', maxBytes: 5 * 1024 * 1024, keep: 5 }) : null;
  const sink = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = chunk.toString();
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        const line = parseLogLine(raw);
        if (line) ring.push(line);
        file?.write(raw + '\n');
        if (options.stdout) process.stdout.write(raw + '\n');
      }
      cb();
    },
  });
  const logger = pino(
    {
      level: options.level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      // No pid/hostname: a log line should carry the request's own context, not the container's.
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label, number) => ({ level: number, levelName: label }) },
    },
    sink,
  );
  return { logger, ring, file };
}
