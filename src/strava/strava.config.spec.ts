import { ConfigService } from '@nestjs/config';
import { StravaConfig } from './strava.config';

const base = {
  STRAVA_CLIENT_ID: '12345',
  STRAVA_CLIENT_SECRET: 'shh',
  STRAVA_REDIRECT_URI: 'https://app.example.com/runner/strava/callback',
  STRAVA_TOKEN_ENCRYPTION_KEY: 'k'.repeat(40),
  FRONTEND_URL: 'https://app.example.com/',
};
const make = (env: Record<string, string | undefined>) =>
  new StravaConfig({ get: (k: string) => env[k] } as unknown as ConfigService);

describe('StravaConfig (fail fast at startup)', () => {
  it('accepts a valid configuration and applies defaults', () => {
    const c = make(base);
    expect(c.enabled).toBe(true);
    expect(c.frontendUrl).toBe('https://app.example.com');
    expect(c.eventTimezone).toBe('Asia/Manila');
    expect(c.uploadMaxBytes).toBe(10 * 1024 * 1024);
    expect(c.dateToleranceDays).toBe(0);
  });

  it.each(['STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REDIRECT_URI', 'FRONTEND_URL'])('throws when %s is missing', (k) => {
    expect(() => make({ ...base, [k]: undefined })).toThrow(/Invalid Strava configuration/);
  });

  it('rejects a short encryption key', () => {
    expect(() => make({ ...base, STRAVA_TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(/at least 32/);
  });

  it('requires the redirect URI to live on the frontend origin', () => {
    expect(() => make({ ...base, STRAVA_REDIRECT_URI: 'https://evil.example.org/cb' })).toThrow(/same origin/);
  });

  it('rejects bad tolerance, size and timezone values', () => {
    expect(() => make({ ...base, STRAVA_ACTIVITY_DATE_TOLERANCE_DAYS: '30' })).toThrow(/between 0 and 7/);
    expect(() => make({ ...base, STRAVA_UPLOAD_MAX_BYTES: '5' })).toThrow(/>= 1024/);
    expect(() => make({ ...base, STRAVA_EVENT_TIMEZONE: 'Mars/Olympus' })).toThrow(/time zone/);
  });

  it('can be disabled without any other configuration', () => {
    const c = make({ STRAVA_ENABLED: 'false' });
    expect(c.enabled).toBe(false);
  });

  it('never includes secret values in the error message', () => {
    expect.assertions(2);
    try {
      make({ ...base, STRAVA_TOKEN_ENCRYPTION_KEY: 'tinykey-7391', STRAVA_CLIENT_SECRET: 'TOP-SECRET-VALUE' });
    } catch (e) {
      expect((e as Error).message).not.toContain('TOP-SECRET-VALUE');
      expect((e as Error).message).not.toContain('tinykey-7391');
    }
  });
});
