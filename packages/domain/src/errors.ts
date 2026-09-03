export type DomainErrorCode =
  | 'validation'
  | 'not-found'
  | 'forbidden'
  | 'unauthenticated'
  | 'conflict'
  | 'rate-limited'
  | 'unavailable'
  | 'unsupported'
  | 'setup-required'
  | 'upgrade-required'
  | 'internal';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: DomainErrorCode, message: string, options: { details?: Record<string, unknown>; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DomainError';
    this.code = code;
    this.status = STATUS[code];
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const STATUS: Record<DomainErrorCode, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'rate-limited': 429,
  unavailable: 503,
  unsupported: 422,
  'setup-required': 403,
  'upgrade-required': 426,
  internal: 500,
};

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : 'Unknown error';
}
