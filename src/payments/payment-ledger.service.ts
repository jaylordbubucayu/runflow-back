import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentLogSource, PaymentStatusLog } from './entities/payment-status-log.entity';
import { PaymentPurpose, PaymentStatus } from '../common/enums';

export interface TransitionContext {
  source: PaymentLogSource;
  note?: string;
  metadata?: Record<string, any>;
  /** Extra columns to write in the same save (paidAt, providerPaymentId, …). */
  patch?: Partial<Payment>;
}

/**
 * The payment state machine plus its audit trail. Everything that changes `payments.status` goes
 * through `transition()`, so a late or duplicate event can never silently downgrade a PAID payment
 * and every change leaves a row in `payment_status_logs`.
 */
@Injectable()
export class PaymentLedgerService {
  /**
   * PAID is terminal except for refunds. FAILED / EXPIRED / CANCELLED may still become PAID,
   * because those are OUR bookkeeping states: if PayMongo reports a real payment on a link we had
   * already given up on, the money exists and must be recorded (then reconciled by the caller).
   */
  static readonly ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
    [PaymentStatus.PENDING]: [
      PaymentStatus.PAID,
      PaymentStatus.FAILED,
      PaymentStatus.EXPIRED,
      PaymentStatus.CANCELLED,
    ],
    [PaymentStatus.FAILED]: [PaymentStatus.PAID],
    [PaymentStatus.EXPIRED]: [PaymentStatus.PAID],
    [PaymentStatus.CANCELLED]: [PaymentStatus.PAID],
    [PaymentStatus.PAID]: [PaymentStatus.REFUNDED],
    [PaymentStatus.REFUNDED]: [],
  };

  canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
    return PaymentLedgerService.ALLOWED[from]?.includes(to) ?? false;
  }

  /** Row-locks the payment for the rest of the surrounding transaction. */
  lock(manager: EntityManager, paymentId: string): Promise<Payment | null> {
    return manager.findOne(Payment, {
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /** Returns true when the status changed, false when it was a no-op or a blocked transition. */
  async transition(
    manager: EntityManager,
    payment: Payment,
    to: PaymentStatus,
    ctx: TransitionContext,
  ): Promise<boolean> {
    const from = payment.status;
    if (from === to) return false;

    if (!this.canTransition(from, to)) {
      await this.log(manager, payment.id, from, from, ctx.source, `blocked ${from} -> ${to}`, ctx.metadata);
      return false;
    }

    const patch: Partial<Payment> = { ...(ctx.patch ?? {}), status: to };
    if (to === PaymentStatus.PAID) patch.paidGuardKey = this.guardKey(payment);
    Object.assign(payment, patch);
    await manager.save(Payment, payment);
    await this.log(manager, payment.id, from, to, ctx.source, ctx.note, ctx.metadata);
    return true;
  }

  /** One paid row per registration / per organizer event fee (enforced by a UNIQUE index). */
  private guardKey(p: Payment): string | null {
    if (p.purpose === PaymentPurpose.ORGANIZER_EVENT_CREATION && p.eventId) return `org:${p.eventId}`;
    if (p.purpose === PaymentPurpose.RUNNER_REGISTRATION && p.registrationId) return `reg:${p.registrationId}`;
    return null;
  }

  async log(
    manager: EntityManager,
    paymentId: string,
    from: PaymentStatus | string | null,
    to: PaymentStatus | string,
    source: PaymentLogSource,
    note?: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await manager.insert(PaymentStatusLog, {
      paymentId,
      fromStatus: from,
      toStatus: to,
      source,
      note: note?.slice(0, 255) ?? null,
      metadata: metadata ?? null,
    });
  }
}