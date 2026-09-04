import type { ProblemDetails } from '@now-playing/contracts';
import { DomainError, type DomainErrorCode } from '@now-playing/domain';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  422: 'Unprocessable Content',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export interface ProblemBody extends ProblemDetails {
  /** Structured validation issues or extra context (never secrets). */
  details?: Record<string, unknown>;
}

export function problem(status: number, options: { code?: string; detail?: string; correlationId?: string; retryAfterSeconds?: number; details?: Record<string, unknown>; title?: string } = {}): ProblemBody {
  const body: ProblemBody = { type: 'about:blank', title: options.title ?? TITLES[status] ?? 'Error', status };
  if (options.detail !== undefined) body.detail = options.detail;
  if (options.code !== undefined) body.code = options.code;
  if (options.correlationId !== undefined) body.correlationId = options.correlationId;
  if (options.retryAfterSeconds !== undefined) body.retryAfterSeconds = options.retryAfterSeconds;
  if (options.details !== undefined) body.details = options.details;
  return body;
}

export function problemFromDomainError(err: DomainError, correlationId: string): ProblemBody {
  const opts: Parameters<typeof problem>[1] = { code: err.code, detail: err.message, correlationId };
  if (err.retryAfterSeconds !== undefined) opts.retryAfterSeconds = err.retryAfterSeconds;
  if (err.details !== undefined) opts.details = err.details;
  return problem(err.status, opts);
}

export function domainError(code: DomainErrorCode, message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(code, message, details ? { details } : {});
}

export const notFound = (what: string): DomainError => new DomainError('not-found', `${what} not found`);
export const forbidden = (message: string, details?: Record<string, unknown>): DomainError => new DomainError('forbidden', message, details ? { details } : {});
export const unauthenticated = (message = 'Authentication required'): DomainError => new DomainError('unauthenticated', message);
export const conflict = (message: string, details?: Record<string, unknown>): DomainError => new DomainError('conflict', message, details ? { details } : {});
export const invalid = (message: string, details?: Record<string, unknown>): DomainError => new DomainError('validation', message, details ? { details } : {});
export const unsupported = (message: string, details?: Record<string, unknown>): DomainError => new DomainError('unsupported', message, details ? { details } : {});
