import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, LessThan, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Payment } from './entities/payment.entity';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentPurpose, PaymentStatus, RegistrationStatus } from '../common/enums';
import { Registration } from '../registrations/entities/registration.entity';
import { RegistrationsService } from '../registrations/registrations.service';
import { PaymongoService } from './paymongo.service';

/** Proof of payment, always sourced from PayMongo (a verified webhook or a server-side API fetch). */
export interface PaidEvidence {
  providerPaymentId: string | null;
  amountCentavos: number;
  currency: string;
  method?: string | null;
  paidAt?: Date | null;
  source: 'webhook' | 'reconcile';
  webhookPayload?: Record<string, any>;
}

export type SettleOutcome =
  | { outcome: 'paid'; paymentId: string; registrationIds: string[] }
  | { outcome: 'already_paid'; paymentId: string }
  | { outcome: 'duplicate_payment'; paymentId: string }
  | { outcome: 'amount_mismatch'; paymentId: string }
  | { outcome: 'not_found' };

/**
 * Decides what a payment MEANS once PayMongo says it was paid (or never was). It is the only place
 * that turns a payment into a business effect, and it always reads the payment's purpose from the
 * stored row — never from the request or the webhook body:
 *
 *   RUNNER_REGISTRATION       -> confirm the registration(s): bib number, QR becomes visible, email.
 *   ORGANIZER_EVENT_CREATION  -> the PAID row itself is what unlocks publishing (see
 *                                OrganizerFeeService.assertSatisfied); nothing is published here.
 */
@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);
  /** paymentId -> last time we asked PayMongo, to keep status polling from hammering their API. */
  private readonly lastProviderCheck = new Map<string, number>();

  constructor(
    @InjectRepository(Payment) private readonly paymentsRepo: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly ledger: PaymentLedgerService,
    private readonly paymongo: PaymongoService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => RegistrationsService))
    private readonly registrationsService: RegistrationsService,
  ) {}

  // ---- paid ---------------------------------------------------------------------------------

  async applyPaid(paymentId: string, evidence: PaidEvidence): Promise<SettleOutcome> {
    const result = await this.dataSource.transaction(async (manager): Promise<SettleOutcome> => {
      const payment = await this.ledger.lock(manager, paymentId);
      if (!payment) return { outcome: 'not_found' };

      if (payment.status === PaymentStatus.PAID) {
        const other =
          evidence.providerPaymentId &&
          payment.providerPaymentId &&
          evidence.providerPaymentId !== payment.providerPaymentId;
        if (other) {
          payment.needsReconciliation = true;
          payment.reconciliationNote = `Extra payment ${evidence.providerPaymentId} received on an already-paid link`;
          await manager.save(Payment, payment);
          await this.ledger.log(manager, payment.id, payment.status, payment.status, evidence.source,
            'duplicate payment on paid link', { providerPaymentId: evidence.providerPaymentId });
          return { outcome: 'duplicate_payment', paymentId: payment.id };
        }
        return { outcome: 'already_paid', paymentId: payment.id };
      }

      // Verify what was actually charged against what we asked for.
      if (
        evidence.amountCentavos !== payment.amountCentavos ||
        (evidence.currency ?? 'PHP').toUpperCase() !== payment.currency.toUpperCase()
      ) {
        payment.needsReconciliation = true;
        payment.reconciliationNote =
          `Amount/currency mismatch: expected ${payment.amountCentavos} ${payment.currency}, ` +
          `got ${evidence.amountCentavos} ${evidence.currency}`;
        await manager.save(Payment, payment);
        await this.ledger.log(manager, payment.id, payment.status, payment.status, evidence.source,
          'amount mismatch - not applied', { evidence: { ...evidence, webhookPayload: undefined } });
        return { outcome: 'amount_mismatch', paymentId: payment.id };
      }

      // A second real payment for something that is already paid (e.g. a superseded link that was
      // still payable): never create a second PAID row — record it and flag it for a refund.
      const duplicateReason = await this.findDuplicateReason(manager, payment);
      if (duplicateReason) {
        await this.flagDuplicate(manager, payment, evidence, duplicateReason);
        return { outcome: 'duplicate_payment', paymentId: payment.id };
      }

      // A provider payment id can belong to exactly one of our rows.
      if (evidence.providerPaymentId) {
        const taken = await manager.findOne(Payment, { where: { providerPaymentId: evidence.providerPaymentId } });
        if (taken && taken.id !== payment.id) {
          payment.needsReconciliation = true;
          payment.reconciliationNote = `Provider payment ${evidence.providerPaymentId} is already recorded on payment ${taken.id}`;
          await manager.save(Payment, payment);
          return { outcome: 'duplicate_payment', paymentId: payment.id };
        }
      }

      const previous = payment.status;
      await this.ledger.transition(manager, payment, PaymentStatus.PAID, {
        source: evidence.source,
        note: previous === PaymentStatus.PENDING ? 'payment confirmed by PayMongo' : `late payment on ${previous} attempt`,
        metadata: { providerPaymentId: evidence.providerPaymentId },
        patch: {
          providerPaymentId: evidence.providerPaymentId ?? payment.providerPaymentId,
          paymentMethod: evidence.method ?? null,
          paidAt: evidence.paidAt ?? new Date(),
          webhookPayload: evidence.webhookPayload ?? payment.webhookPayload,
        },
      });

      let registrationIds: string[] = [];
      if (payment.purpose === PaymentPurpose.RUNNER_REGISTRATION) {
        registrationIds = await this.confirmRunnerRegistrations(manager, payment);
      }
      return { outcome: 'paid', paymentId: payment.id, registrationIds };
    });

    // Emitted AFTER commit so listeners never read half-written state.
    if (result.outcome === 'paid') {
      for (const registrationId of result.registrationIds) {
        this.eventEmitter.emit('payment.succeeded', { registrationId });
      }
      const payment = await this.paymentsRepo.findOne({ where: { id: result.paymentId } });
      if (payment?.purpose === PaymentPurpose.ORGANIZER_EVENT_CREATION) {
        this.eventEmitter.emit('organizer_event_fee.paid', {
          paymentId: payment.id,
          eventId: payment.eventId,
          organizationId: payment.organizationId,
        });
      }
    }
    return result;
  }

  private async confirmRunnerRegistrations(manager: EntityManager, payment: Payment): Promise<string[]> {
    const regRepo = manager.getRepository(Registration);
    const ids = payment.registrationId
      ? [payment.registrationId]
      : (await regRepo.find({ where: { paymentId: payment.id } })).map((r) => r.id);

    const confirmed: string[] = [];
    const problems: string[] = [];

    for (const id of ids) {
      const reg = await regRepo.findOne({ where: { id } });
      if (!reg) {
        problems.push(`registration ${id} no longer exists`);
        continue;
      }
      if (reg.status === RegistrationStatus.CANCELLED) {
        // Paid after the registration was cancelled/expired: take the slot back if one is free.
        const revived = await this.registrationsService.reviveForLatePayment(id, regRepo);
        if (!revived) {
          problems.push(`registration ${id} was cancelled and no slot is available`);
          continue;
        }
      }
      await this.registrationsService.markPaid(id, regRepo);
      confirmed.push(id);
    }

    if (problems.length) {
      payment.needsReconciliation = true;
      payment.reconciliationNote = `Paid but not fully applied (refund or manual fix needed): ${problems.join('; ')}`.slice(0, 255);
      await manager.save(Payment, payment);
      await this.ledger.log(manager, payment.id, payment.status, payment.status, 'system', 'reconciliation required', { problems });
    }
    return confirmed;
  }

  /** A free registration needs no payment: confirm it directly, exactly as a paid one would be. */
  async confirmFreeRegistrations(registrationIds: string[]): Promise<void> {
    for (const registrationId of registrationIds) {
      await this.registrationsService.markPaid(registrationId);
      this.eventEmitter.emit('payment.succeeded', { registrationId });
    }
  }

  /** Why this payment would be a second payment for something already paid, or null. */
  private async findDuplicateReason(manager: EntityManager, payment: Payment): Promise<string | null> {
    if (payment.purpose === PaymentPurpose.ORGANIZER_EVENT_CREATION) {
      const other = await manager.findOne(Payment, {
        where: { purpose: payment.purpose, eventId: payment.eventId, status: PaymentStatus.PAID },
      });
      return other && other.id !== payment.id
        ? `The platform fee for this event was already paid by payment ${other.id}`
        : null;
    }

    // Runner payment: duplicate if there is nothing left to confirm (everyone already registered).
    const regRepo = manager.getRepository(Registration);
    const regs = payment.registrationId
      ? await regRepo.find({ where: { id: payment.registrationId } })
      : await regRepo.find({ where: { paymentId: payment.id } });
    if (!regs.length) return null;
    const needsConfirming = regs.some(
      (r) => r.status === RegistrationStatus.PENDING_PAYMENT || r.status === RegistrationStatus.CANCELLED,
    );
    return needsConfirming ? null : 'The registration(s) were already confirmed by an earlier payment';
  }

  private async flagDuplicate(
    manager: EntityManager,
    payment: Payment,
    evidence: PaidEvidence,
    reason: string,
  ): Promise<void> {
    payment.needsReconciliation = true;
    payment.reconciliationNote = `Duplicate payment - refund likely needed. ${reason}`.slice(0, 255);
    if (evidence.providerPaymentId) {
      const taken = await manager.findOne(Payment, { where: { providerPaymentId: evidence.providerPaymentId } });
      if (!taken) payment.providerPaymentId = evidence.providerPaymentId; // keep the id for the refund
    }
    await manager.save(Payment, payment);
    // A still-PENDING attempt must not linger once it has taken money it cannot use.
    await this.ledger.transition(manager, payment, PaymentStatus.CANCELLED, {
      source: evidence.source,
      note: 'duplicate payment - flagged for reconciliation',
      metadata: { providerPaymentId: evidence.providerPaymentId },
    });
    await this.ledger.log(manager, payment.id, payment.status, payment.status, evidence.source, reason);
  }

  // ---- ask PayMongo (webhook handling and status polling) --------------------------------------

  /**
   * Asks PayMongo — server-to-server, with our secret key — for the PAID payments of this
   * payment's link and applies each one. This is the single source of truth for "was it paid and
   * for how much": a webhook only tells us WHERE to look, and the browser's redirect or an active
   * link proves nothing. Works for any current status, so a late payment on an expired/cancelled
   * attempt is still recorded. Throws if PayMongo cannot be reached (callers decide whether to
   * retry or swallow).
   */
  async settleFromProvider(paymentId: string): Promise<SettleOutcome[]> {
    const payment = await this.paymentsRepo.findOneOrFail({ where: { id: paymentId } });
    if (!payment.providerCheckoutId) return [];
    const paid = await this.paymongo.listPaidPayments(payment.providerCheckoutId);
    const outcomes: SettleOutcome[] = [];
    for (const p of paid) {
      outcomes.push(
        await this.applyPaid(payment.id, {
          providerPaymentId: p.id,
          amountCentavos: p.amountCentavos,
          currency: p.currency,
          method: p.method,
          paidAt: p.paidAt,
          source: 'reconcile',
        }),
      );
    }
    return outcomes;
  }

  /** Status polling: settle a still-PENDING payment if PayMongo reports it paid (throttled). */
  async refreshFromProvider(paymentId: string, opts: { force?: boolean } = {}): Promise<Payment> {
    const payment = await this.paymentsRepo.findOneOrFail({ where: { id: paymentId } });
    if (payment.status !== PaymentStatus.PENDING || !payment.providerCheckoutId) return payment;

    const minGap = Number(process.env.PAYMENT_REFRESH_MIN_INTERVAL_SECONDS ?? 8) * 1000;
    const last = this.lastProviderCheck.get(paymentId) ?? 0;
    if (!opts.force && Date.now() - last < minGap) return payment;
    this.lastProviderCheck.set(paymentId, Date.now());
    if (this.lastProviderCheck.size > 5000) this.lastProviderCheck.clear();

    try {
      await this.settleFromProvider(paymentId);
    } catch (err: any) {
      // A PayMongo hiccup must not turn a status check into an error page.
      this.logger.warn(`Provider refresh failed for payment ${paymentId}: ${err?.message}`);
    }
    return this.paymentsRepo.findOneOrFail({ where: { id: paymentId } });
  }

  // ---- expiry / supersede ---------------------------------------------------------------------

  /** PENDING -> EXPIRED. For runners this also releases the held slot(s). Returns true if expired. */
  async expire(paymentId: string, source: 'expiry' | 'api' = 'expiry'): Promise<boolean> {
    let expired: Payment | null = null;
    await this.dataSource.transaction(async (manager) => {
      const payment = await this.ledger.lock(manager, paymentId);
      if (!payment || payment.status !== PaymentStatus.PENDING) return;
      const changed = await this.ledger.transition(manager, payment, PaymentStatus.EXPIRED, {
        source,
        note: 'payment link timed out',
      });
      if (changed) expired = payment;
    });
    if (!expired) return false;

    await this.archiveQuietly(expired);
    if ((expired as Payment).purpose === PaymentPurpose.RUNNER_REGISTRATION) {
      await this.cancelPendingRegistrationsOf(expired);
    }
    return true;
  }

  /**
   * PENDING -> CANCELLED because a newer attempt replaced it. Returns true if it changed.
   * The caller must call `archiveQuietly(payment)` AFTER its transaction commits — archiving talks
   * to PayMongo and must not happen if the transaction rolls back.
   */
  supersede(manager: EntityManager, payment: Payment, note: string): Promise<boolean> {
    return this.ledger.transition(manager, payment, PaymentStatus.CANCELLED, { source: 'api', note });
  }

  /** Called when a runner registration is cancelled: stop any link that could still be paid for it. */
  async onRegistrationCancelled(registrationId: string): Promise<void> {
    const reg = await this.dataSource.getRepository(Registration).findOne({ where: { id: registrationId } });
    if (!reg) return;

    let payments: Payment[] = [];
    if (reg.paymentId) {
      // Group payment: only cancel it once nobody in the group is still waiting to pay.
      const waiting = await this.dataSource.getRepository(Registration).count({
        where: { paymentId: reg.paymentId, status: RegistrationStatus.PENDING_PAYMENT },
      });
      if (waiting === 0) {
        payments = await this.paymentsRepo.find({ where: { id: reg.paymentId, status: PaymentStatus.PENDING } });
      }
    } else {
      payments = await this.paymentsRepo.find({
        where: { registrationId, purpose: PaymentPurpose.RUNNER_REGISTRATION, status: PaymentStatus.PENDING },
      });
    }
    for (const p of payments) {
      let cancelled: Payment | null = null;
      await this.dataSource.transaction(async (manager) => {
        const locked = await this.ledger.lock(manager, p.id);
        if (locked && locked.status === PaymentStatus.PENDING) {
          const changed = await this.ledger.transition(manager, locked, PaymentStatus.CANCELLED, {
            source: 'api',
            note: 'registration cancelled',
          });
          if (changed) cancelled = locked;
        }
      });
      if (cancelled) await this.archiveQuietly(cancelled as Payment);
    }
  }

  /** Expires every pending link past its timeout. Safe to run from several instances at once. */
  async expireStale(limit = 50): Promise<number> {
    const stale = await this.paymentsRepo.find({
      where: { status: PaymentStatus.PENDING, expiresAt: LessThan(new Date()) },
      order: { expiresAt: 'ASC' },
      take: limit,
    });
    let n = 0;
    for (const p of stale) {
      // Ask PayMongo first: a link that was actually paid must be settled, not expired.
      const fresh = await this.refreshFromProvider(p.id, { force: true });
      if (fresh.status === PaymentStatus.PENDING && (await this.expire(p.id))) n++;
    }
    return n;
  }

  // ---- helpers --------------------------------------------------------------------------------

  private async cancelPendingRegistrationsOf(payment: Payment): Promise<void> {
    const regRepo = this.dataSource.getRepository(Registration);
    const regs = payment.registrationId
      ? await regRepo.find({ where: { id: payment.registrationId } })
      : await regRepo.find({ where: { paymentId: payment.id } });
    const ids = regs.filter((r) => r.status === RegistrationStatus.PENDING_PAYMENT).map((r) => r.id);
    for (const id of ids) {
      try {
        await this.registrationsService.cancel(id);
      } catch (err: any) {
        this.logger.warn(`Could not release registration ${id} after expiry: ${err?.message}`);
      }
    }
  }

  async archiveQuietly(payment: Payment): Promise<void> {
    if (!payment.providerCheckoutId) return;
    try {
      await this.paymongo.archivePaymentLink(payment.providerCheckoutId);
    } catch (err: any) {
      // The link stays payable at worst; a payment on it is handled by the late-payment path.
      this.logger.warn(`Could not archive link ${payment.providerCheckoutId}: ${err?.message}`);
    }
  }
}