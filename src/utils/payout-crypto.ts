import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM helpers for payout account numbers. Stored format: base64(iv):base64(tag):base64(ciphertext).
 * The key is derived from PAYOUT_ENCRYPTION_SECRET via scrypt, so the secret can be any string.
 * Format and salt are unchanged from the original in OrganizerService, so existing rows still decrypt.
 */
const SALT = 'runflow-payout-salt';

const deriveKey = (secret: string) => scryptSync(secret, SALT, 32);

export function encryptAccountNumber(raw: string, secret: string): { encrypted: string; last4: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const encrypted = [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join(':');
  return { encrypted, last4: raw.replace(/\D/g, '').slice(-4) };
}

/** Only used at the moment a transfer is submitted; the plaintext is never stored or logged. */
export function decryptAccountNumber(payload: string, secret: string): string {
  const [iv, tag, ciphertext] = payload.split(':').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !ciphertext) throw new Error('Malformed encrypted account number');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
