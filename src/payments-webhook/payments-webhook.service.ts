import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebhookEventStatus } from '../common/enums';
import { PaymentWebhookEvent } from './entities/payments-webhook-event.entity';
import { Payment } from 'src/payments/entities/payment.entity';
import { PaidEvidence, PaymentSettlementService } from 'src/payments/payment-settlement.service';
import { PaymongoService } from 'src/payments/paymongo.service';

/** The only PayMongo event this integration acts on: a Payment Link received a payment. */
export const LINK_PAID_EVENT = 'link.payment.paid';

/**
 * Verifies and applies PayMongo webhooks. Order of operations:
 *   1. verify the signature over the RAW body (reject with 401 otherwise),
 *   2. record the event by PayMongo's event id (redeliveries are recognised and not re-applied),
 *   3. find OUR payment by the link id we stored — the purpose (runner vs organizer) is whatever
 *      that stored row says, never anything in the request,
 *   4. try PayMongo's API for that link's paid payments; if the API does not expose them
 *      (GET /payment_links/:id returns status=active with no payments), fall back to the
 *      signature-verified event body itself. Either way the evidence goes through
 *      PaymentSettlementService, which checks amount/currency against OUR stored row and applies
 *      the business effect idempotently.
 * Failures after step 2 return 5xx so PayMongo retries; "nothing to do" cases return 200.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    @InjectRepository(PaymentWebhookEvent) private readonly eventsRepo: Repository<PaymentWebhookEvent>,
    @InjectRepository(Payment) private readonly paymentsRepo: Repository<Payment>,
    private readonly paymongo: PaymongoService,
    private readonly settlement: PaymentSettlementService,
  ) {}

  async handle(rawBody: Buffer | undefined, signature: string | undefined) {
    this.paymongo.verifyWebhookSignature(rawBody, signature);

    let payload: any;
    try {
      payload = JSON.parse(rawBody!.toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid JSON');
    }
    const eventId: string | undefined = payload?.data?.id;
    const type: string | undefined = payload?.data?.attributes?.type;
    if (!eventId || !type) throw new BadRequestException('Not a PayMongo event');

    // Idempotency: the unique key on provider_event_id decides who processes this delivery.
    let record = await this.eventsRepo.findOne({ where: { providerEventId: eventId } });
    if (record && record.status !== WebhookEventStatus.FAILED && record.status !== WebhookEventStatus.RECEIVED) {
      return { received: true, duplicate: true };
    }
    if (!record) {
      try {
        record = await this.eventsRepo.save(
          this.eventsRepo.create({ providerEventId: eventId, eventType: type, payload }),
        );
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') return { received: true, duplicate: true }; // concurrent delivery
        throw err;
      }
    }

    try {
      const detail = await this.apply(type, payload, record);
      await this.eventsRepo.update(record.id, {
        status: detail.ignored ? WebhookEventStatus.IGNORED : WebhookEventStatus.PROCESSED,
        detail: detail.text.slice(0, 500),
        paymentId: detail.paymentId ?? null,
        processedAt: new Date(),
      });
      return { received: true };
    } catch (err: any) {
      this.logger.error(`Webhook ${eventId} (${type}) failed: ${err?.message}`);
      await this.eventsRepo.update(record.id, {
        status: WebhookEventStatus.FAILED,
        detail: String(err?.message ?? 'error').slice(0, 500),
      });
      throw err; // 5xx => PayMongo retries with backoff
    }
  }

  private async apply(
    type: string,
    payload: any,
    record: PaymentWebhookEvent,
  ): Promise<{ text: string; ignored?: boolean; paymentId?: string }> {
    if (type !== LINK_PAID_EVENT) return { text: `unsupported event type ${type}`, ignored: true };

    // The (signature-verified) event tells us WHICH link was paid. How the link is embedded in the
    // event is not part of PayMongo's published schema, so collect every identifier it carries.
    const hints = PaymentWebhookService.extractHints(payload);
    const payment = await this.findPayment(hints.linkIds, hints.refs);
    if (!payment) return { text: `unknown link ${hints.linkIds.join('|') || '(none)'}`, ignored: true };

    // Preferred: ask PayMongo's API for the link's paid payments.
    const outcomes = await this.settlement.settleFromProvider(payment.id);
    if (outcomes.length) {
      return { text: outcomes.map((o) => o.outcome).join(','), paymentId: payment.id };
    }

    // Fallback: GET /payment_links/:id does not expose payments (it reports status=active), so use
    // the signature-verified event body. applyPaid still checks amount and currency against the
    // amount stored on OUR payment row, so a wrong or partial amount is never marked paid.
    const evidence = PaymentWebhookService.evidenceFromEvent(payload);
    if (!evidence) {
      throw new ServiceUnavailableException(`Link ${payment.providerCheckoutId} is not reported paid`);
    }
    const outcome = await this.settlement.applyPaid(payment.id, evidence);
    return { text: `${outcome.outcome} (verified webhook)`, paymentId: payment.id };
  }

  /**
   * Builds payment evidence from a link.payment.paid event body. Only call this on an event whose
   * signature has already been verified (handle() does that first).
   */
  static evidenceFromEvent(payload: any): PaidEvidence | null {
    const link = payload?.data?.attributes?.data;
    const a = link?.attributes;
    if (!a || a.status !== 'paid') return null;

    // Use PayMongo's real payment id (pay_…) if the event carries one; otherwise a stable
    // per-link id, so the same link can never be recorded as two different payments.
    let payId: string | null = null;
    const walk = (v: any, depth: number) => {
      if (payId || depth > 8 || v == null) return;
      if (typeof v === 'string') {
        if (/^pay_[A-Za-z0-9]+$/.test(v)) payId = v;
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    walk(a, 0);

    return {
      providerPaymentId: payId ?? `link-paid:${link.id}`,
      amountCentavos: Number(a.amount),
      currency: String(a.currency ?? 'PHP').toUpperCase(),
      method: null,
      paidAt: new Date(),
      source: 'webhook',
      webhookPayload: payload,
    };
  }

  /** Pulls link ids (`link_…`) and our own references out of an arbitrary event payload. */
  static extractHints(payload: any): { linkIds: string[]; refs: string[] } {
    const linkIds = new Set<string>();
    const refs = new Set<string>();
    const walk = (v: any, depth: number) => {
      if (depth > 8 || v == null) return;
      if (typeof v === 'string') {
        if (/^link_[A-Za-z0-9]+$/.test(v)) linkIds.add(v);
        const m = /RUNFLOW-PAYMENT-(\d+)/.exec(v);
        if (m) refs.add(m[1]);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
    };
    // Skip the event's own id (`evt_…`); walk the embedded resource only.
    walk(payload?.data?.attributes?.data, 0);
    return { linkIds: [...linkIds], refs: [...refs] };
  }

  /**
   * By the link id we stored. Fallback for a link PayMongo created but whose response we never
   * received (timeout): our payment id is in the link's metadata/remarks, and since the event is
   * signature-verified that text is ours. Only a payment with no link yet may adopt a link.
   */
  private async findPayment(linkIds: string[], refs: string[]): Promise<Payment | null> {
    for (const linkId of linkIds) {
      const byLink = await this.paymentsRepo.findOne({ where: { providerCheckoutId: linkId } });
      if (byLink) return byLink;
    }
    for (const ref of refs) {
      const candidate = await this.paymentsRepo.findOne({ where: { id: ref } });
      if (candidate && !candidate.providerCheckoutId && linkIds.length === 1) {
        candidate.providerCheckoutId = linkIds[0];
        return this.paymentsRepo.save(candidate);
      }
    }
    return null;
  }
}