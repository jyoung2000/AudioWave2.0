import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { keyFingerprint } from '@now-playing/domain';

export interface HubKeyPair {
  /** Base64url raw Ed25519 public key (32 bytes). */
  publicKey: string;
  /** PKCS8 PEM private key — stored sealed. */
  privateKeyPem: string;
}

export function generateHubKeyPair(): HubKeyPair {
  const kp = generateKeyPairSync('ed25519');
  return { publicKey: rawPublicKey(kp.publicKey), privateKeyPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Unexpected Ed25519 public key encoding');
  return jwk.x;
}

export function publicKeyFromPrivatePem(pem: string): string {
  return rawPublicKey(createPublicKey(createPrivateKey(pem)));
}

export function signWithHubKey(privateKeyPem: string, data: Uint8Array): string {
  return sign(null, data, createPrivateKey(privateKeyPem)).toString('base64url');
}

export function verifyHubSignature(publicKeyRaw: string, data: Uint8Array, signature: string): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyRaw }, format: 'jwk' });
  return verify(null, data, key, Buffer.from(signature, 'base64url'));
}

export async function hubFingerprint(publicKeyRaw: string): Promise<string> {
  return keyFingerprint(publicKeyRaw);
}
