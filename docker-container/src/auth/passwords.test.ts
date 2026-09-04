import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './passwords.js';

const FAST = { memoryCost: 8, timeCost: 1, parallelism: 1 };

describe('checkPasswordPolicy', () => {
  it('requires twelve characters', () => {
    expect(checkPasswordPolicy('short1234', 'admin').ok).toBe(false);
    expect(checkPasswordPolicy('correct horse battery', 'admin').ok).toBe(true);
  });

  it('rejects the bootstrap password and the username', () => {
    expect(checkPasswordPolicy('admin', 'admin').ok).toBe(false);
    expect(checkPasswordPolicy('operator', 'operator').ok).toBe(false);
    expect(checkPasswordPolicy('operator-is-here', 'operator').ok).toBe(false);
  });

  it('rejects the passwords an attacker tries first, padded or not', () => {
    for (const weak of ['password1234', 'Password123!', 'letmein12345', 'qwerty123456', 'changeme1234', 'nowplaying12']) {
      expect(checkPasswordPolicy(weak, 'admin'), weak).toMatchObject({ ok: false });
    }
  });

  it('accepts a passphrase that merely contains a common word', () => {
    // "password" as one word among several is fine; the denylist targets the whole password.
    expect(checkPasswordPolicy('my password is a rhinoceros', 'admin').ok).toBe(true);
  });

  it('rejects counting and keyboard runs', () => {
    expect(checkPasswordPolicy('1234567890ab', 'admin').ok).toBe(false);
    expect(checkPasswordPolicy('qwertyuiop12', 'admin').ok).toBe(false);
  });

  it('rejects a single repeated character', () => {
    expect(checkPasswordPolicy('aaaaaaaaaaaaaa', 'admin').ok).toBe(false);
  });
});

describe('argon2id hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('a-real-password-1234', FAST);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'a-real-password-1234')).toBe(true);
    expect(await verifyPassword(hash, 'a-real-password-1235')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    expect(await hashPassword('a-real-password-1234', FAST)).not.toBe(await hashPassword('a-real-password-1234', FAST));
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});
