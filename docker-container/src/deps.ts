import type { Logger } from 'pino';
import type { HubConfig } from './config.js';
import type { ProviderAdapter } from './providers/adapter.js';

/** Unix-millisecond clock; injectable so tests can move time. */
export interface Clock {
  now(): number;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface FfmpegInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  encoders: string[];
}

export interface PasswordHashingParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export type RateLimitClassName = 'default' | 'auth' | 'pairing' | 'search' | 'write';

/** Everything the hub needs from the outside world; `buildApp` fills in production defaults for what is omitted. */
export interface HubDeps {
  config: HubConfig;
  clock?: Clock;
  random?: RandomSource;
  fetch?: typeof globalThis.fetch;
  /** Resolve a hostname to all of its addresses (used for the post-DNS SSRF check). */
  dnsLookup?: (hostname: string) => Promise<string[]>;
  ffmpegLocator?: () => Promise<FfmpegInfo>;
  /** Additional provider adapters (tests inject fixture providers). */
  extraAdapters?: ProviderAdapter[];
  /** Replace a built-in adapter by id (tests). */
  replaceAdapters?: Record<string, ProviderAdapter>;
  passwordHashing?: PasswordHashingParams;
  /** Per-class request limits per minute; tests raise them to exercise flows without tripping 429s. */
  rateLimits?: Partial<Record<RateLimitClassName, number>>;
  version?: string;
  migrationsDir?: string;
  webDistDir?: string;
  openApiPath?: string;
  logger?: Logger;
  /** 'stdout' (default), 'silent' (tests) — file/ring buffer logging is always on. */
  logDestination?: 'stdout' | 'silent';
  /** Disable background loops (tests that need deterministic timing). */
  disableBackgroundJobs?: boolean;
  /** Startup time override for uptime metrics. */
  startedAt?: number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemRandom: RandomSource = {
  bytes(length) {
    const out = new Uint8Array(length);
    globalThis.crypto.getRandomValues(out);
    return out;
  },
};
