import { StravaCryptoService } from './strava-crypto.service';
import { StravaConfig } from './strava.config';

const cfg = (key: string, prev?: string) => ({ encryptionKey: key, previousEncryptionKey: prev }) as unknown as StravaConfig;
const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

describe('StravaCryptoService', () => {
  const svc = new StravaCryptoService(cfg(KEY_A));

  it('round-trips and never contains the plaintext', () => {
    const enc = svc.encrypt('super-secret-access-token', '42');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('super-secret');
    expect(svc.decrypt(enc, '42')).toBe('super-secret-access-token');
  });

  it('uses a fresh IV every time', () => {
    expect(svc.encrypt('same', '1')).not.toBe(svc.encrypt('same', '1'));
  });

  it('rejects a ciphertext moved to another user (AAD binding)', () => {
    const enc = svc.encrypt('token', '1');
    expect(() => svc.decrypt(enc, '2')).toThrow('Token decryption failed');
  });

  it('rejects tampered ciphertext', () => {
    const enc = svc.encrypt('token', '1');
    const parts = enc.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => svc.decrypt(parts.join('.'), '1')).toThrow();
  });

  it('rejects unknown formats', () => {
    expect(() => svc.decrypt('v9.a.b.c', '1')).toThrow();
    expect(() => svc.decrypt('garbage', '1')).toThrow();
  });

  it('supports key rotation via the previous key', () => {
    const old = new StravaCryptoService(cfg(KEY_A)).encrypt('rotating', '7');
    const rotated = new StravaCryptoService(cfg(KEY_B, KEY_A));
    expect(rotated.decrypt(old, '7')).toBe('rotating');
    // ...and new writes use the new key only
    const fresh = rotated.encrypt('rotating', '7');
    expect(() => new StravaCryptoService(cfg(KEY_A)).decrypt(fresh, '7')).toThrow();
  });

  it('cannot decrypt with an unrelated key', () => {
    const enc = svc.encrypt('x', '1');
    expect(() => new StravaCryptoService(cfg(KEY_B)).decrypt(enc, '1')).toThrow();
  });
});
