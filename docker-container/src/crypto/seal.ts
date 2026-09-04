import { createCipheriv, createDecipheriv } from 'node:crypto';
import type { RandomSource } from '../deps.js';

const VERSION = 'v1';
const IV_BYTES = 12;

export interface Sealer {
  seal(plaintext: string, aad?: string): string;
  open(sealed: string, aad?: string): string;
}

/** AES-256-GCM with a random 96-bit nonce; output `v1.<iv>.<ciphertext>.<tag>` (base64url). */
export function createSealer(key: Uint8Array, random: RandomSource): Sealer {
  if (key.length !== 32) throw new Error('Sealing key must be 32 bytes');
  return {
    seal(plaintext, aad) {
      const iv = random.bytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, Buffer.from(iv).toString('base64url'), body.toString('base64url'), tag.toString('base64url')].join('.');
    },
    open(sealed, aad) {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised sealed value');
      const iv = Buffer.from(parts[1]!, 'base64url');
      const body = Buffer.from(parts[2]!, 'base64url');
      const tag = Buffer.from(parts[3]!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}
