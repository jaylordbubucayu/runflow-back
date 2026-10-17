import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { StravaConfig } from './strava.config';

/**
 * AES-256-GCM, same family the project already uses for payout accounts, with two upgrades:
 * a version prefix (so the format can evolve) and AAD = the owning user id, so a ciphertext
 * copied onto another user's row fails authentication instead of decrypting.
 * Format:  v1.<iv>.<tag>.<ciphertext>   (base64url)
 * Rotation: set the new secret as STRAVA_TOKEN_ENCRYPTION_KEY and move the old one to
 * STRAVA_TOKEN_ENCRYPTION_KEY_PREVIOUS; tokens re-encrypt with the new key on next refresh.
 */
@Injectable()
export class StravaCryptoService {
  private readonly current: Buffer;
  private readonly previous?: Buffer;

  constructor(config: StravaConfig) {
    const derive = (s: string) => scryptSync(s, 'runflow-strava-token-salt', 32);
    this.current = config.encryptionKey ? derive(config.encryptionKey) : Buffer.alloc(32);
    this.previous = config.previousEncryptionKey ? derive(config.previousEncryptionKey) : undefined;
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  decrypt(payload: string, aad: string): string {
    const [version, iv, tag, ct] = payload.split('.');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised token payload');
    const attempt = (key: Buffer) => {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    };
    try {
      return attempt(this.current);
    } catch (err) {
      if (!this.previous) throw new Error('Token decryption failed');
      try {
        return attempt(this.previous);
      } catch {
        throw new Error('Token decryption failed');
      }
    }
  }
}
