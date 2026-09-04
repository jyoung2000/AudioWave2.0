import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANDING } from '@now-playing/contracts';

export type BindMode = 'localhost' | 'lan' | 'remote';
export type IpLoggingMode = 'truncated' | 'hashed' | 'full';

export interface HubConfig {
  dataDir: string;
  port: number;
  bindMode: BindMode;
  bindAddress: string | null;
  publicEndpoint: string | null;
  trustedProxyCidrs: string[];
  logLevel: string;
  discordToken: string | null;
  installKeyFile: string;
  ipLogging: IpLoggingMode;
  ffmpegPath: string | null;
  publicDomainDir: string | null;
  demoMode: boolean;
  nodeEnv: string;
}

const BIND_MODES: readonly BindMode[] = ['localhost', 'lan', 'remote'];
const IP_MODES: readonly IpLoggingMode[] = ['truncated', 'hashed', 'full'];

function text(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t.length ? t : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T, key: string): T {
  if (value === null) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} must be one of ${allowed.join(', ')} (got "${value}")`);
}

export function parsePort(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`NP_PORT must be an integer between 1 and 65535 (got "${value}")`);
  return n;
}

export function parseCidrList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((cidr) => {
      if (!/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(cidr)) throw new Error(`Invalid CIDR in NP_TRUSTED_PROXY_CIDRS: ${cidr}`);
      return cidr;
    });
}

export function parsePublicEndpoint(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NP_PUBLIC_ENDPOINT must be an absolute http(s) URL (got "${value}")`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('NP_PUBLIC_ENDPOINT must use http or https');
  if (url.username || url.password) throw new Error('NP_PUBLIC_ENDPOINT must not contain credentials');
  return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

/** Workspace default for the public-domain provider: the generated test fixtures, when this checkout has them. */
export function defaultPublicDomainDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'packages', 'test-fixtures', 'generated', 'audio'),
    join(here, '..', '..', '..', 'packages', 'test-fixtures', 'generated', 'audio'),
    join(process.cwd(), 'packages', 'test-fixtures', 'generated', 'audio'),
    join(process.cwd(), '..', 'packages', 'test-fixtures', 'generated', 'audio'),
  ];
  for (const c of candidates) if (existsSync(join(c, 'manifest.json'))) return resolve(c);
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dataDir = resolve(text(env, 'NP_DATA_DIR') ?? '/data');
  const demo = (text(env, 'NP_DEMO_MODE') ?? 'false').toLowerCase();
  if (!['true', 'false', '1', '0'].includes(demo)) throw new Error('NP_DEMO_MODE must be true or false');
  return {
    dataDir,
    port: parsePort(text(env, 'NP_PORT'), BRANDING.hubPort),
    bindMode: oneOf(text(env, 'NP_BIND_MODE'), BIND_MODES, 'localhost', 'NP_BIND_MODE'),
    bindAddress: text(env, 'NP_BIND_ADDRESS'),
    publicEndpoint: parsePublicEndpoint(text(env, 'NP_PUBLIC_ENDPOINT')),
    trustedProxyCidrs: parseCidrList(text(env, 'NP_TRUSTED_PROXY_CIDRS')),
    logLevel: text(env, 'NP_LOG_LEVEL') ?? 'info',
    discordToken: text(env, 'NP_DISCORD_TOKEN'),
    installKeyFile: text(env, 'NP_INSTALL_KEY_FILE') ?? join(dataDir, 'keys', 'install.key'),
    ipLogging: oneOf(text(env, 'NP_IP_LOGGING'), IP_MODES, 'truncated', 'NP_IP_LOGGING'),
    ffmpegPath: text(env, 'NP_FFMPEG_PATH'),
    publicDomainDir: text(env, 'NP_PUBLIC_DOMAIN_DIR') ?? defaultPublicDomainDir(),
    demoMode: demo === 'true' || demo === '1',
    nodeEnv: text(env, 'NODE_ENV') ?? 'development',
  };
}

/** Sub-directories created under the data directory on startup. */
export const DATA_SUBDIRS = ['keys', 'blobs', 'downloads', 'artwork', 'backups', 'logs', 'library'] as const;

export function dataPath(config: Pick<HubConfig, 'dataDir'>, ...parts: string[]): string {
  return join(config.dataDir, ...parts);
}
