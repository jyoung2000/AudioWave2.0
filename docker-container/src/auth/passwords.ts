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

/** Minimum 12 characters (contract), not the bootstrap password, not equal to the username, some variety. */
export function checkPasswordPolicy(password: string, username: string): PasswordPolicyResult {
  if (password.length < 12) return { ok: false, reason: 'Password must be at least 12 characters' };
  if (password.length > 512) return { ok: false, reason: 'Password is too long' };
  if (password.toLowerCase() === 'admin' || password.toLowerCase() === username.toLowerCase()) return { ok: false, reason: 'Password must differ from the username and the bootstrap password' };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: 'Password must not repeat a single character' };
  return { ok: true };
}
