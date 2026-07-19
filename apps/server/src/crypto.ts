import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for stored pre-signed delegation transactions
 * (security-review-delegation.md requirement 3). AES-256-GCM; the blob is
 * self-describing (`enc:v1:` prefix) so plaintext rows written before the key
 * was configured keep working, and enabling the key never needs a migration.
 * A DB leak without the env key then yields no submittable transaction.
 */

const PREFIX = 'enc:v1:';

/** 64-char hex → raw 32 bytes; anything else is treated as a passphrase and sha256-derived. */
export function parseDelegationKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.length === 0) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw, 'utf8').digest();
}

function isEncrypted(blob: string): boolean {
  return blob.startsWith(PREFIX);
}

export function encryptDelegation(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Plaintext blobs pass through; encrypted blobs require the key and an intact GCM tag. */
export function decryptDelegation(blob: string, key: Buffer | null): string {
  if (!isEncrypted(blob)) return blob;
  if (key === null) throw new Error('delegation blob is encrypted but DELEGATION_ENC_KEY is not configured');
  const parts = blob.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed encrypted delegation blob');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8');
}
