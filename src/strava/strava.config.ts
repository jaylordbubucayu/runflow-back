import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Reads + validates Strava configuration once, at application bootstrap (the provider is
 * instantiated eagerly), so a missing/invalid value fails the deploy instead of the first user.
 * Set STRAVA_ENABLED=false to boot without Strava (endpoints then answer 503).
 */
@Injectable()
export class StravaConfig {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly frontendUrl: string;
  readonly encryptionKey: string;
  readonly previousEncryptionKey?: string;
  readonly uploadMaxBytes: number;
  readonly eventTimezone: string;
  readonly dateToleranceDays: number;

  readonly authorizeUrl = 'https://www.strava.com/oauth/authorize';
  readonly tokenUrl = 'https://www.strava.com/oauth/token';
  readonly revokeUrl = 'https://www.strava.com/oauth/revoke';
  readonly apiBase = 'https://www.strava.com/api/v3';

  constructor(config: ConfigService) {
    const get = (k: string) => (config.get<string>(k) ?? '').trim();
    this.enabled = get('STRAVA_ENABLED').toLowerCase() !== 'false';

    this.clientId = get('STRAVA_CLIENT_ID');
    this.clientSecret = get('STRAVA_CLIENT_SECRET');
    this.redirectUri = get('STRAVA_REDIRECT_URI');
    this.frontendUrl = get('FRONTEND_URL').replace(/\/+$/, '');
    this.encryptionKey = get('STRAVA_TOKEN_ENCRYPTION_KEY');
    this.previousEncryptionKey = get('STRAVA_TOKEN_ENCRYPTION_KEY_PREVIOUS') || undefined;
    this.uploadMaxBytes = Number(get('STRAVA_UPLOAD_MAX_BYTES') || 10 * 1024 * 1024);
    this.eventTimezone = get('STRAVA_EVENT_TIMEZONE') || 'Asia/Manila';
    this.dateToleranceDays = Number(get('STRAVA_ACTIVITY_DATE_TOLERANCE_DAYS') || 0);

    if (!this.enabled) return;

    const problems: string[] = [];
    if (!this.clientId) problems.push('STRAVA_CLIENT_ID is required');
    if (!this.clientSecret) problems.push('STRAVA_CLIENT_SECRET is required');
    if (!this.frontendUrl) problems.push('FRONTEND_URL is required');
    if (this.encryptionKey.length < 32) {
      problems.push('STRAVA_TOKEN_ENCRYPTION_KEY must be at least 32 characters (e.g. `openssl rand -base64 48`)');
    }
    try {
      const u = new URL(this.redirectUri);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      if (this.frontendUrl && new URL(this.frontendUrl).origin !== u.origin) {
        problems.push('STRAVA_REDIRECT_URI must be on the same origin as FRONTEND_URL (the callback page lives in the Nuxt app)');
      }
    } catch {
      problems.push('STRAVA_REDIRECT_URI must be an absolute http(s) URL');
    }
    if (!Number.isInteger(this.uploadMaxBytes) || this.uploadMaxBytes < 1024) {
      problems.push('STRAVA_UPLOAD_MAX_BYTES must be an integer >= 1024');
    }
    if (!Number.isInteger(this.dateToleranceDays) || this.dateToleranceDays < 0 || this.dateToleranceDays > 7) {
      problems.push('STRAVA_ACTIVITY_DATE_TOLERANCE_DAYS must be an integer between 0 and 7');
    }
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: this.eventTimezone });
    } catch {
      problems.push('STRAVA_EVENT_TIMEZONE must be a valid IANA time zone');
    }
    if (problems.length) {
      throw new Error(`Invalid Strava configuration:\n - ${problems.join('\n - ')}`);
    }
  }
}
