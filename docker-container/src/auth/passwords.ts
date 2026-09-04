import argon2 from '@node-rs/argon2';
import type { PasswordHashingParams } from '../deps.js';

/** Argon2id per docs/SECURITY.md: 64 MiB, 3 passes, single lane, 16-byte random salt (library default). */
export const PRODUCTION_HASHING: PasswordHashingParams = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

/* `Algorithm.Argon2id` is an ambient const enum in the package typings, which isolatedModules forbids referencing; its value is 2. */
const ARGON2ID = 2;

export async function hashPassword(password: string, params: PasswordHashingParams = PRODUCTION_HASHING): Promise<string> {
  return argon2.hash(password, { memoryCost: params.memoryCost, timeCost: params.timeCost, parallelism: params.parallelism, algorithm: ARGON2ID });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Words that appear at the top of every credential-stuffing list. Length alone does not help when
 * the twelve characters are "password1234", so those stems are rejected even when padded.
 *
 * This is a short, honest denylist, not a breach-corpus check: it catches the handful of passwords
 * an automated attempt tries first, and the error message says to use a passphrase or a manager
 * rather than pretending the hub can score password strength.
 */
const WEAK_STEMS = ['password', 'passw0rd', 'letmein', 'welcome', 'qwerty', 'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'trustno1', 'admin', 'administrator', 'nowplaying', 'changeme', 'default'] as const;

/** Minimum 12 characters (contract), not the bootstrap password, not the username, not an obvious guess. */
export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'Password must be at least 12 characters' };
  if (password.length > 512) return { ok: false, reason: 'Password is too long' };
  const lower = password.toLowerCase();
  if (lower === 'admin' || lower === username.toLowerCase()) return { ok: false, reason: 'Password must differ from the username and the bootstrap password' };
  if (lower.includes(username.toLowerCase()) && username.length >= 4) return { ok: false, reason: 'Password must not contain the username' };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: 'Password must not repeat a single character' };

  // Strip trailing digits and punctuation before matching, so "password1234!" is caught too.
  const stem = lower.replace(/[^a-z]/g, '');
  if (WEAK_STEMS.some((weak) => stem === weak || (stem.startsWith(weak) && stem.length - weak.length <= 3))) {
    return { ok: false, reason: 'That password is one of the first an attacker tries. Use a passphrase of several unrelated words, or a password manager.' };
  }
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)) return { ok: false, reason: 'Password must not be a keyboard or counting sequence' };
  return { ok: true };
}
