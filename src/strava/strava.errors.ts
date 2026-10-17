import { HttpException, HttpStatus } from '@nestjs/common';
import { StravaErrorCode } from './strava.constants';

/**
 * Error bodies keep Nest's shape ({statusCode, message, error}) but put a machine-readable code
 * in `error`, which is the field the Nuxt API client already surfaces as ApiError.error.
 *
 * NEVER use 401 for Strava problems: the existing frontend treats any 401 from this API as
 * "your RunFlow session expired" and logs the user out. Strava-side auth problems are 409.
 */
export function stravaError(
  status: HttpStatus,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ statusCode: status, message, error: code, ...extra }, status);
}

/** Internal error from the Strava HTTP client; mapped to HttpExceptions by callers. */
export class StravaApiError extends Error {
  constructor(
    public readonly kind: 'http' | 'network_definite' | 'network_ambiguous',
    public readonly status: number | null,
    public readonly body: unknown,
    public readonly retryAfterSec?: number,
    message?: string,
  ) {
    super(message ?? `Strava ${kind}${status ? ` ${status}` : ''}`);
    this.name = 'StravaApiError';
  }

  /** The request definitely did not create anything at Strava. */
  get definitelyNotProcessed(): boolean {
    if (this.kind === 'network_definite') return true;
    if (this.kind === 'network_ambiguous') return false;
    // 4xx = rejected. 5xx = unknown: the server may have done the work before failing.
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}


/** Maps an upstream failure to a safe, user-facing HttpException (never echoes upstream bodies). */
export function mapStravaError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (!(err instanceof StravaApiError)) {
    return stravaError(HttpStatus.BAD_GATEWAY, StravaErrorCode.UPSTREAM, 'Unexpected error while talking to Strava.');
  }
  if (err.status === 429) {
    const secs = err.retryAfterSec ?? 900;
    return stravaError(
      HttpStatus.TOO_MANY_REQUESTS,
      StravaErrorCode.RATE_LIMITED,
      `Strava is limiting requests right now. Please try again in about ${Math.max(1, Math.ceil(secs / 60))} minute(s).`,
      { retryAfterSeconds: secs },
    );
  }
  if (err.status === 401) {
    return stravaError(HttpStatus.CONFLICT, StravaErrorCode.REVOKED, 'Your Strava connection is no longer valid. Please reconnect Strava.');
  }
  if (err.status === 403) {
    return stravaError(HttpStatus.FORBIDDEN, StravaErrorCode.MISSING_SCOPE, 'RunFlow does not have permission to add activities to your Strava. Please reconnect and allow "Upload your activities to Strava".');
  }
  if (err.kind !== 'http' || (err.status !== null && err.status >= 500)) {
    return stravaError(HttpStatus.SERVICE_UNAVAILABLE, StravaErrorCode.UNAVAILABLE, 'Strava is not responding right now. Please try again shortly.');
  }
  return stravaError(HttpStatus.BAD_GATEWAY, StravaErrorCode.UPSTREAM, 'Strava rejected the request.');
}
