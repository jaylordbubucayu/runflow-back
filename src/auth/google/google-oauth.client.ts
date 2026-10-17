import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { GoogleAuthConfig } from './google.config';
import { GoogleLoginError } from './google.constants';

export interface GoogleProfile {
  googleId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLOCK_SKEW_S = 60;

export const b64url = (b: Buffer) => b.toString('base64url');
export const sha256b64url = (s: string) => b64url(createHash('sha256').update(s).digest());

/**
 * Validates the OIDC ID token's CLAIMS. The token is received directly from Google's token endpoint
 * over TLS in exchange for our one-time code + client secret, which is the case Google's docs say
 * does not require re-verifying the signature. We still enforce everything else.
 */
export function validateIdToken(
  idToken: unknown,
  expected: { clientId: string; nonce: string; now?: number },
): GoogleProfile {
  const bad = () => new GoogleLoginError('exchange_failed');
  if (typeof idToken !== 'string') throw bad();
  const parts = idToken.split('.');
  if (parts.length !== 3) throw bad();

  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!c || typeof c !== 'object') throw bad();

  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  if (typeof c.iss !== 'string' || !ISSUERS.includes(c.iss)) throw bad();
  const aud = c.aud;
  if (!(aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId) && c.azp === expected.clientId))) throw bad();
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S < now) throw bad();
  if (typeof c.iat === 'number' && c.iat - CLOCK_SKEW_S > now) throw bad();
  if (typeof c.nonce !== 'string' || c.nonce !== expected.nonce) throw bad();
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw bad();
  if (typeof c.email !== 'string' || !c.email.includes('@') || c.email.length > 255) throw bad();
  if (c.email_verified !== true) throw new GoogleLoginError('email_unverified');

  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
  return { googleId: c.sub, email: c.email.trim().toLowerCase(), firstName: s(c.given_name), lastName: s(c.family_name) };
}

@Injectable()
export class GoogleOAuthClient {
  constructor(private readonly cfg: GoogleAuthConfig) {}

  newPkce() {
    const verifier = b64url(randomBytes(48)); // 64 chars, within RFC 7636's 43–128
    return { verifier, challenge: sha256b64url(verifier) };
  }

  buildAuthUrl(p: { state: string; nonce: string; challenge: string }): string {
    const url = new URL(this.cfg.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account', // never silently pick whichever Google account the browser last used
    }).toString();
    return url.toString();
  }

  /** Exchanges the code (+PKCE verifier) for tokens and returns the validated profile. */
  async exchange(code: string, verifier: string, nonce: string): Promise<GoogleProfile> {
    let res: Response;
    try {
      res = await fetch(this.cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          redirect_uri: this.cfg.callbackUrl,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleLoginError('exchange_failed');
    }
    if (!res.ok) throw new GoogleLoginError('exchange_failed');
    let body: { id_token?: unknown };
    try {
      body = (await res.json()) as { id_token?: unknown };
    } catch {
      throw new GoogleLoginError('exchange_failed');
    }
    return validateIdToken(body.id_token, { clientId: this.cfg.clientId, nonce });
  }
}
