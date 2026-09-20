/**
 * Signed media URLs.
 *
 * `<audio>` cannot send `Authorization`, so a device asks for a URL carrying `?sig=` instead. The
 * signature binds one path to one device credential for a few hours, and the credential is looked
 * up again on every request: revoking the device revokes its URLs. The secret never enters a URL.
 */
import { createHmac } from 'node:crypto';
import { timingSafeEqual } from '@now-playing/domain';

export const MEDIA_SIGNATURE_TTL_MS = 6 * 3600 * 1000;
const CREDENTIAL_RE = /^[A-Za-z0-9-]{36}$/;

function mac(key: Uint8Array, path: string, credentialId: string, expiresAt: number): string {
  return createHmac('sha256', key).update(`media:v1\n${path}\n${credentialId}\n${expiresAt}`).digest('base64url');
}

export function signMediaPath(key: Uint8Array, path: string, credentialId: string, now: number): { sig: string; expiresAt: number } {
  const expiresAt = now + MEDIA_SIGNATURE_TTL_MS;
  return { sig: `${credentialId}.${expiresAt}.${mac(key, path, credentialId, expiresAt)}`, expiresAt };
}

/** The credential a valid signature was issued to, or null. Never throws. */
export function verifyMediaSignature(key: Uint8Array, path: string, sig: string, now: number): string | null {
  const [credentialId, exp, digest, extra] = sig.split('.');
  if (extra !== undefined || !credentialId || !exp || !digest || !CREDENTIAL_RE.test(credentialId) || !/^\d{1,16}$/.test(exp)) return null;
  const expiresAt = Number(exp);
  if (expiresAt <= now || expiresAt > now + MEDIA_SIGNATURE_TTL_MS) return null;
  return timingSafeEqual(digest, mac(key, path, credentialId, expiresAt)) ? credentialId : null;
}
