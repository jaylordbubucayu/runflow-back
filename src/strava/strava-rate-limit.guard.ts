import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StravaConfig } from './strava.config';
import { stravaError } from './strava.errors';
import { StravaErrorCode } from './strava.constants';

export const STRAVA_RATE_LIMIT = 'strava:rate-limit';
export const SKIP_STRAVA_ENABLED = 'strava:skip-enabled';
/** Per-user sliding window, e.g. @StravaRateLimit(10, 60_000) = 10 requests/minute/user/route. */
export const StravaRateLimit = (limit: number, windowMs: number) => SetMetadata(STRAVA_RATE_LIMIT, { limit, windowMs });
export const SkipStravaEnabledCheck = () => SetMetadata(SKIP_STRAVA_ENABLED, true);

/**
 * Protects both Strava's shared app-wide quota and our own API from a single noisy user.
 * In-memory (per process): fine for one instance; use a Redis-backed limiter if you scale out.
 */
@Injectable()
export class StravaRateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector, private readonly cfg: StravaConfig) {}

  /** Drops all counters (used by tests; also handy if you ever need to lift limits at runtime). */
  clear(): void {
    this.hits.clear();
  }

  canActivate(ctx: ExecutionContext): boolean {
    const skipEnabled = this.reflector.get<boolean>(SKIP_STRAVA_ENABLED, ctx.getHandler());
    if (!this.cfg.enabled && !skipEnabled) {
      throw stravaError(HttpStatus.SERVICE_UNAVAILABLE, StravaErrorCode.NOT_CONFIGURED, 'Strava integration is not enabled on this server.');
    }
    const rule = this.reflector.get<{ limit: number; windowMs: number }>(STRAVA_RATE_LIMIT, ctx.getHandler());
    if (!rule) return true;

    const req = ctx.switchToHttp().getRequest();
    const key = `${req.user?.id ?? req.ip}:${ctx.getClass().name}.${ctx.getHandler().name}`;
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    if (recent.length >= rule.limit) {
      const retryAfter = Math.ceil((rule.windowMs - (now - recent[0])) / 1000);
      throw stravaError(HttpStatus.TOO_MANY_REQUESTS, StravaErrorCode.RATE_LIMITED, 'Too many requests. Please slow down and try again shortly.', { retryAfterSeconds: retryAfter });
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 60_000)) this.hits.delete(k);
    return true;
  }
}
