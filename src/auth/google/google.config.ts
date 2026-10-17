import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';

/**
 * Validated once at bootstrap. Google sign-in is optional: with none of the three GOOGLE_* values
 * set it is simply off (routes answer 503 / `not_configured`). A *partial or malformed* setup fails
 * the boot with a precise message instead of surfacing as a broken button in production.
 */
@Injectable()
export class GoogleAuthConfig {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  /** The API's own callback URL — must be listed under "Authorized redirect URIs" in Google Cloud. */
  readonly callbackUrl: string;
  readonly frontendUrl: string;
  readonly secureCookies: boolean;
  /** Key for the signed state cookie; derived from (never equal to) JWT_ACCESS_SECRET. */
  readonly stateKey: Buffer;

  readonly authorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  readonly tokenUrl = 'https://oauth2.googleapis.com/token';

  constructor(config: ConfigService) {
    const get = (k: string) => (config.get<string>(k) ?? '').trim();
    this.clientId = get('GOOGLE_CLIENT_ID');
    this.clientSecret = get('GOOGLE_CLIENT_SECRET');
    this.callbackUrl = get('GOOGLE_CALLBACK_URL');
    this.frontendUrl = get('FRONTEND_URL').replace(/\/+$/, '');
    this.secureCookies = (config.get<string>('NODE_ENV') ?? '') === 'production';

    const provided = [this.clientId, this.clientSecret, this.callbackUrl].filter(Boolean).length;
    this.enabled = provided === 3;
    this.stateKey = Buffer.alloc(32);
    if (provided === 0) return;

    const problems: string[] = [];
    if (!this.clientId) problems.push('GOOGLE_CLIENT_ID is required');
    if (!this.clientSecret) problems.push('GOOGLE_CLIENT_SECRET is required');
    if (!this.callbackUrl) problems.push('GOOGLE_CALLBACK_URL is required (e.g. https://api.example.com/api/auth/google/callback)');
    else {
      try {
        const u = new URL(this.callbackUrl);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        if (!u.pathname.endsWith('/auth/google/callback')) problems.push('GOOGLE_CALLBACK_URL must end with /auth/google/callback');
        if (this.secureCookies && u.protocol !== 'https:') problems.push('GOOGLE_CALLBACK_URL must be https in production');
      } catch {
        problems.push('GOOGLE_CALLBACK_URL must be an absolute http(s) URL');
      }
    }
    if (!this.frontendUrl) problems.push('FRONTEND_URL is required');
    const base = get('JWT_ACCESS_SECRET');
    if (base.length < 16) problems.push('JWT_ACCESS_SECRET (used to derive the state-cookie key) must be at least 16 characters');
    if (problems.length) throw new Error(`Invalid Google sign-in configuration:\n - ${problems.join('\n - ')}`);

    // Domain-separated key so a leaked cookie signature says nothing about JWT signing.
    this.stateKey = createHmac('sha256', base).update('runflow:google-oauth-state:v1').digest();
  }
}
