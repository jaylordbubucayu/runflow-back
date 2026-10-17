import { Injectable, Logger } from '@nestjs/common';
import { StravaConfig } from './strava.config';
import { StravaApiError } from './strava.errors';

export interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  expires_in?: number;
  scope?: string;
  athlete?: { id: number; firstname?: string; lastname?: string; username?: string };
}

export interface StravaUploadResponse {
  id: number | string;
  id_str?: string;
  external_id: string | null;
  error: string | null;
  status: string;
  activity_id: number | string | null;
}

export interface StravaDetailedActivity {
  id: number | string;
  name?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  start_date_local?: string;
  sport_type?: string;
}

interface Usage {
  limit15: number;
  limitDay: number;
  usage15: number;
  usageDay: number;
  at: number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Thin wrapper over Node's fetch. It owns: timeouts, response-header rate-limit accounting,
 * and the one classification that matters for safety — did a failed request *definitely* not
 * reach Strava's business logic? (see StravaApiError.definitelyNotProcessed).
 *
 * No automatic retries here for anything non-idempotent. GET /uploads/{id} retries are driven
 * by the BullMQ poll loop, and token calls are never blindly retried (refresh tokens rotate).
 */
@Injectable()
export class StravaHttpClient {
  private readonly logger = new Logger(StravaHttpClient.name);
  private overall: Usage | null = null; // X-RateLimit-*     (all requests)
  private read: Usage | null = null; // X-ReadRateLimit-*  (non-upload reads)
  private blockedUntil = 0;

  constructor(private readonly cfg: StravaConfig) {}

  // ---- rate limits ------------------------------------------------------------------------

  /** Seconds until the 15-minute window rolls over (windows end at :00/:15/:30/:45). */
  private secondsToQuarter(now = Date.now()): number {
    const q = 15 * 60 * 1000;
    return Math.max(1, Math.ceil((q - (now % q)) / 1000));
  }

  private secondsToUtcMidnight(now = Date.now()): number {
    const d = 24 * 3600 * 1000;
    return Math.max(1, Math.ceil((d - (now % d)) / 1000));
  }

  /** Throws a rate-limited StravaApiError (status 429) when we know the budget is spent. */
  assertBudget(kind: 'overall' | 'read'): void {
    const now = Date.now();
    if (now < this.blockedUntil) {
      throw new StravaApiError('http', 429, null, Math.ceil((this.blockedUntil - now) / 1000));
    }
    const u = kind === 'read' ? this.read : this.overall;
    if (!u) return;
    const q = 15 * 60 * 1000;
    if (Math.floor(u.at / q) === Math.floor(now / q) && u.usage15 >= u.limit15) {
      throw new StravaApiError('http', 429, null, this.secondsToQuarter(now));
    }
    const day = 24 * 3600 * 1000;
    if (Math.floor(u.at / day) === Math.floor(now / day) && u.usageDay >= u.limitDay) {
      throw new StravaApiError('http', 429, null, this.secondsToUtcMidnight(now));
    }
  }

  private parsePair(limit: string | null, usage: string | null): Usage | null {
    if (!limit || !usage) return null;
    const [l15, lDay] = limit.split(',').map((n) => Number(n.trim()));
    const [u15, uDay] = usage.split(',').map((n) => Number(n.trim()));
    if ([l15, lDay, u15, uDay].some((n) => !Number.isFinite(n))) return null;
    return { limit15: l15, limitDay: lDay, usage15: u15, usageDay: uDay, at: Date.now() };
  }

  private recordHeaders(h: Headers): void {
    const o = this.parsePair(h.get('x-ratelimit-limit'), h.get('x-ratelimit-usage'));
    const r = this.parsePair(h.get('x-readratelimit-limit'), h.get('x-readratelimit-usage'));
    if (o) this.overall = o;
    if (r) this.read = r;
    for (const [name, u] of [['overall', o], ['read', r]] as const) {
      if (u && (u.usage15 >= u.limit15 * 0.8 || u.usageDay >= u.limitDay * 0.8)) {
        this.logger.warn(`Strava ${name} rate-limit usage high: 15min ${u.usage15}/${u.limit15}, day ${u.usageDay}/${u.limitDay}`);
      }
    }
  }

  // ---- core request -----------------------------------------------------------------------

  private async send<T>(
    url: string,
    init: RequestInit,
    budget: 'overall' | 'read' | null,
    timeoutMs: number,
  ): Promise<T> {
    if (budget) this.assertBudget(budget);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      const code: string | undefined = err?.cause?.code ?? err?.code;
      // DNS failure / connection refused: nothing reached Strava. Anything else (timeout, reset,
      // abort) happened after we may have sent the request -> outcome unknown.
      const definite = code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
      throw new StravaApiError(definite ? 'network_definite' : 'network_ambiguous', null, null, undefined, `network:${code ?? err?.name}`);
    }
    this.recordHeaders(res.headers);

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* Strava sometimes returns HTML on errors; keep as text, never surfaced to users */
    }

    if (res.status === 429) {
      const wait = this.secondsToQuarter();
      this.blockedUntil = Date.now() + wait * 1000;
      throw new StravaApiError('http', 429, body, wait);
    }
    if (!res.ok) throw new StravaApiError('http', res.status, body);
    return body as T;
  }

  private bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // ---- OAuth ------------------------------------------------------------------------------

  exchangeCode(code: string): Promise<StravaTokenResponse> {
    return this.send(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        grant_type: 'authorization_code',
      }),
    }, null, REQUEST_TIMEOUT_MS);
  }

  refresh(refreshToken: string): Promise<StravaTokenResponse> {
    return this.send(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    }, null, REQUEST_TIMEOUT_MS);
  }

  /** POST /oauth/revoke (HTTP Basic client credentials) — replaces /oauth/deauthorize. */
  async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    await this.send(this.cfg.revokeUrl, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }, null, REQUEST_TIMEOUT_MS);
  }

  // ---- Activities / uploads ---------------------------------------------------------------

  createActivity(
    token: string,
    p: { name: string; sport_type: string; start_date_local: string; elapsed_time: number; distance?: number; description?: string },
  ): Promise<StravaDetailedActivity> {
    const form = new URLSearchParams({
      name: p.name,
      sport_type: p.sport_type,
      start_date_local: p.start_date_local,
      elapsed_time: String(p.elapsed_time),
    });
    if (p.distance !== undefined) form.set('distance', String(p.distance));
    if (p.description) form.set('description', p.description);
    return this.send(`${this.cfg.apiBase}/activities`, {
      method: 'POST',
      headers: { ...this.bearer(token), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
    }, 'overall', REQUEST_TIMEOUT_MS);
  }

  createUpload(
    token: string,
    p: { file: Buffer; dataType: 'fit' | 'tcx' | 'gpx'; externalId: string; name?: string; description?: string },
  ): Promise<StravaUploadResponse> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(p.file)]), `activity.${p.dataType}`);
    form.set('data_type', p.dataType);
    form.set('external_id', p.externalId);
    if (p.name) form.set('name', p.name);
    if (p.description) form.set('description', p.description);
    return this.send(`${this.cfg.apiBase}/uploads`, {
      method: 'POST',
      headers: { ...this.bearer(token), Accept: 'application/json' },
      body: form, // fetch sets the multipart boundary itself
    }, 'overall', UPLOAD_TIMEOUT_MS);
  }

  getUpload(token: string, uploadId: string): Promise<StravaUploadResponse> {
    return this.send(`${this.cfg.apiBase}/uploads/${encodeURIComponent(uploadId)}`, {
      method: 'GET',
      headers: { ...this.bearer(token), Accept: 'application/json' },
    }, 'read', REQUEST_TIMEOUT_MS);
  }
}
