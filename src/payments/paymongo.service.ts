import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** A payment received through a Payment Link (one entry per successful payment). */
export interface PaymongoLinkPayment {
  id: string; // pay_…
  status: string; // 'paid'
  amountCentavos: number;
  currency: string;
  method: string | null; // e.g. 'gcash', 'card', 'paymaya'
  paidAt: Date | null;
}

/**
 * The subset of a Payment Link (`/v1/payment_links`) this app uses, normalised. NOTE: a link's
 * `status` is only 'active' | 'archived' — whether it was PAID is answered by its payments list
 * (see listPaidPayments), never by the link itself.
 */
export interface PaymongoLink {
  id: string; // link_…
  referenceNumber: string | null; // PayMongo-generated; the code in the pm.link URL
  checkoutUrl: string; // the link's `url`
  status: string; // 'active' | 'archived'
  archived: boolean;
  amountCentavos: number;
  currency: string;
  remarks: string | null;
  metadata: Record<string, string>;
}

export interface CreatePaymentLinkInput {
  amountCentavos: number;
  currency?: string; // defaults to PHP
  /** Customer-facing text on the PayMongo page. */
  description: string;
  /** Internal note (not shown to customers). */
  remarks?: string;
  /** String key/values stored on the link — we store our payment id to recover from timeouts. */
  metadata?: Record<string, string>;
}

/**
 * The ONLY class that talks to PayMongo. It knows nothing about registrations, events or
 * organizers: callers pass an amount and get a link back; callers decide what a payment means.
 *
 * Auth is HTTP Basic with the secret key as the username and an empty password. The secret key
 * is read from the environment on the server and is never logged or returned.
 */
@Injectable()
export class PaymongoService {
  private readonly logger = new Logger(PaymongoService.name);

  constructor(private readonly config: ConfigService) {}

  // ---- configuration ------------------------------------------------------------------------

  private get secretKey(): string | undefined {
    return this.config.get<string>('PAYMONGO_SECRET_KEY') || undefined;
  }

  private get baseUrl(): string {
    return (this.config.get<string>('PAYMONGO_BASE_URL') || 'https://api.paymongo.com/v1').replace(/\/+$/, '');
  }

  private get timeoutMs(): number {
    return Number(this.config.get('PAYMONGO_TIMEOUT_MS') ?? 15000);
  }

  /** PayMongo's documented minimum for a link, in centavos. Overridable in case it changes. */
  get minLinkAmountCentavos(): number {
    return Number(this.config.get('PAYMONGO_MIN_LINK_AMOUNT_CENTAVOS') ?? 100);
  }

  /** 'live' when a live secret key is configured; everything else is treated as test mode. */
  get mode(): 'live' | 'test' {
    return this.secretKey?.startsWith('sk_live_') ? 'live' : 'test';
  }

  isConfigured(): boolean {
    return !!this.secretKey;
  }

  // ---- Payment Links API (/v1/payment_links) -------------------------------------------------

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymongoLink> {
    if (!Number.isInteger(input.amountCentavos) || input.amountCentavos < this.minLinkAmountCentavos) {
      throw new BadGatewayException(
        `Payment amount must be at least ${this.minLinkAmountCentavos} centavos`,
      );
    }
    // Flat body (no `data.attributes` wrapper); `currency` is required by the API.
    const body = {
      amount: input.amountCentavos,
      currency: (input.currency ?? 'PHP').toUpperCase(),
      description: input.description.slice(0, 1000),
      ...(input.remarks ? { remarks: input.remarks.slice(0, 1000) } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const json = await this.request('POST', '/payment_links', body);
    return PaymongoService.parseLink(json?.data);
  }

  async getPaymentLink(linkId: string): Promise<PaymongoLink> {
    const json = await this.request('GET', `/payment_links/${encodeURIComponent(linkId)}`);
    return PaymongoService.parseLink(json?.data);
  }

  /**
   * The PAID payments of a link — the authoritative answer to "was this link paid, and for how
   * much?". (Link `status` only says active/archived.) Amounts are in centavos.
   */
async listPaidPayments(linkId: string): Promise<PaymongoLinkPayment[]> {
  const id = encodeURIComponent(linkId);

  try {
    const json = await this.request('GET', `/payment_links/${id}/payments?status=paid`);
    const list = PaymongoService.parsePayments(json);
    if (list.length) return list;
  } catch (err: any) {
    this.logger.warn(`payments sub-endpoint failed for ${linkId}: ${err?.message}`);
  }

  // Fallback: the link resource itself (server-to-server, so still trustworthy).
  const json = await this.request('GET', `/payment_links/${id}`);
  const r = json?.data?.attributes
    ? { id: json.data.id, ...json.data.attributes }
    : (json?.data ?? json ?? {});
  this.logger.log(`link ${linkId} status=${r.status} amount=${r.amount} payments=${JSON.stringify(r.payments ?? null)}`);

  const embedded = PaymongoService.parsePayments({ data: r.payments ?? [] });
  if (embedded.length) return embedded;

  if (r.status === 'paid') {
    return [{
      id: `link-paid:${linkId}`, // PayMongo exposes no payment id here; unique per link
      status: 'paid',
      amountCentavos: Number(r.amount),
      currency: String(r.currency ?? 'PHP').toUpperCase(),
      method: null,
      paidAt: new Date(),
    }];
  }
  return [];
}

  /** Deactivates a link so it can no longer be paid (used when an attempt is superseded or expires). */
  async archivePaymentLink(linkId: string): Promise<void> {
    await this.request('PATCH', `/payment_links/${encodeURIComponent(linkId)}`, { archive: true });
  }

  // ---- Webhook signature --------------------------------------------------------------------

  /**
   * Verifies the `Paymongo-Signature` header per PayMongo's documented scheme:
   *   header  = "t=<unix ts>,te=<test sig>,li=<live sig>"
   *   expected = HMAC-SHA256(webhookSecret, `${t}.${rawBody}`) as hex
   * and compares it with `li` in live mode or `te` in test mode.
   *
   * It must be given the RAW request body — re-serialising parsed JSON would change the bytes and
   * break the signature. Throws UnauthorizedException on any problem; fails closed (rejects) when
   * no webhook secret is configured.
   *
   * `PAYMONGO_WEBHOOK_TOLERANCE_SECONDS` (default 0 = off) optionally rejects old timestamps.
   * It is off by default because PayMongo retries failed deliveries with backoff, and a strict
   * window could reject a legitimate retry; replay safety comes from event-id deduplication.
   */
  verifyWebhookSignature(rawBody: Buffer | string | undefined, header: string | undefined, nowMs = Date.now()): void {
    const secret = this.config.get<string>('PAYMONGO_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('PAYMONGO_WEBHOOK_SECRET is not set; rejecting webhook');
      throw new UnauthorizedException('Webhook verification is not configured');
    }
    if (!rawBody || !header) throw new UnauthorizedException('Missing webhook signature');

    const parts: Record<string, string> = {};
    for (const piece of header.split(',')) {
      const idx = piece.indexOf('=');
      if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
    }
    const timestamp = parts['t'];
    const provided = this.mode === 'live' ? parts['li'] : parts['te'];
    if (!timestamp || !provided) throw new UnauthorizedException('Malformed webhook signature');

    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const tolerance = Number(this.config.get('PAYMONGO_WEBHOOK_TOLERANCE_SECONDS') ?? 0);
    if (tolerance > 0) {
      const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > tolerance) {
        throw new UnauthorizedException('Webhook timestamp outside tolerance');
      }
    }
  }

  // ---- parsing ------------------------------------------------------------------------------

  /**
   * Normalises a Payment Link resource. The documented shape is flat
   * (`{ id, amount, currency, url, status, reference_number, … }`); `attributes` is tolerated too
   * so a wrapped payload cannot silently produce an empty link.
   */
  static parseLink(resource: any): PaymongoLink {
    const r = resource?.attributes ? { id: resource.id, ...resource.attributes } : (resource ?? {});
    const status: string = r.status ?? 'active';
    return {
      id: r.id,
      referenceNumber: r.reference_number ?? null,
      checkoutUrl: r.url ?? r.checkout_url,
      status,
      archived: status === 'archived' || r.archived === true,
      amountCentavos: Number(r.amount),
      currency: r.currency ?? 'PHP',
      remarks: r.remarks ?? null,
      metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    };
  }

  /**
   * Normalises the response of GET /payment_links/:id/payments. The docs do not publish this
   * response schema, so every field is read defensively; an entry without a usable id or amount
   * yields NaN, which fails the amount check downstream (safe: nothing gets marked paid).
   */
  static parsePayments(json: any): PaymongoLinkPayment[] {
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return list
      .map((entry: any) => {
        const p = entry?.data ?? entry;
        const a = p?.attributes ?? p ?? {};
        const rawPaidAt = a.paid_at ?? a.created_at;
        const paidAt =
          rawPaidAt == null ? null : new Date(typeof rawPaidAt === 'number' ? rawPaidAt * 1000 : rawPaidAt);
        return {
          id: p?.id,
          // The request is filtered with status=paid; a missing status is therefore 'paid'.
          status: a.status ?? 'paid',
          amountCentavos: Number(a.amount),
          currency: String(a.currency ?? 'PHP').toUpperCase(),
          method:
            a.payment_method?.type ?? a.payment_method ?? a.source?.type ?? a.method ?? null,
          paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
        } as PaymongoLinkPayment;
      })
      .filter((p) => !!p.id && p.status === 'paid');
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<any> {
    const key = this.secretKey;
    if (!key) {
      throw new ServiceUnavailableException('Online payments are not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      this.logger.error(`PayMongo ${method} ${path} ${timedOut ? 'timed out' : 'failed'}: ${err?.message}`);
      throw new ServiceUnavailableException(
        timedOut ? 'The payment provider took too long to respond' : 'The payment provider is unreachable',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok) {
      const detail = json?.errors?.[0]?.detail ?? json?.errors?.[0]?.code ?? `HTTP ${res.status}`;
      // Logged for operators; deliberately not echoed to the client.
      this.logger.error(`PayMongo ${method} ${path} -> ${res.status}: ${detail}`);
      if (res.status === 401 || res.status === 403) {
        throw new ServiceUnavailableException('Online payments are temporarily unavailable');
      }
      throw new BadGatewayException('The payment provider rejected the request');
    }
    return json;
  }
}