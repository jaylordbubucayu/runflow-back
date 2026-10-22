import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { Payment } from '../payments/entities/payment.entity';
import { OrganizerPayout } from './entities/organizer-payout.entity';
import { OrganizerPayoutStatus, PaymentPurpose, PaymentStatus } from '../common/enums';
import { centavosToPesos } from '../common/services/money.util';

export interface Money {
  centavos: number;
  /** Pesos as a fixed 2-decimal string, e.g. "1250.00". */
  amount: string;
}

export interface Balance {
  /** Registration fees of PAID runner payments — what the runners paid, minus the platform fee. */
  netCentavos: number;
  /** Part of netCentavos sitting on payments flagged for reconciliation; not withdrawable yet. */
  onHoldCentavos: number;
  paidOutCentavos: number;
  pendingPayoutCentavos: number;
  availableCentavos: number;
}

export interface EarningsSummary {
  currency: 'PHP';
  paymentCount: number;
  /** Everything runners were charged (registration fee + platform fee). */
  totalPayments: Money;
  /** The platform's cut. Never part of the organizer's earnings. */
  platformFees: Money;
  /** totalPayments excluding the platform fee — the organizer's share. This is the card's headline. */
  netEarnings: Money;
  onHold: Money;
  paidOut: Money;
  pendingPayout: Money;
  availableBalance: Money;
}

export interface EventEarnings {
  eventId: string;
  eventName: string;
  paymentCount: number;
  totalPayments: Money;
  platformFees: Money;
  netEarnings: Money;
}

const money = (centavos: number): Money => ({ centavos, amount: centavosToPesos(centavos) });

/**
 * Read-only money maths for the organizer console. Everything is scoped to ONE organization id
 * that the caller has already resolved from the authenticated user, and works in centavos.
 *
 * Only PAID runner-registration payments count. The platform fee a runner pays on top (and the
 * organizer's own event-creation fee, which is a different payment purpose) are never earnings.
 * Payments are matched to the organization through their event (payments.event_id), so guest
 * group payments — which have no single registration — are included.
 */
@Injectable()
export class OrganizerEarningsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Pass `manager` to run inside a caller's transaction (the payout flow does, under a row lock). */
  async getBalance(orgId: string, manager?: EntityManager): Promise<Balance> {
    const m = manager ?? this.dataSource.manager;

    const earned = await m
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin(Event, 'event', 'event.id = payment.eventId')
      .select('COALESCE(SUM(ROUND(payment.registrationFee * 100)), 0)', 'net')
      .addSelect(
        'COALESCE(SUM(CASE WHEN payment.needsReconciliation = 1 THEN ROUND(payment.registrationFee * 100) ELSE 0 END), 0)',
        'hold',
      )
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.RUNNER_REGISTRATION })
      .andWhere('payment.status = :status', { status: PaymentStatus.PAID })
      .getRawOne();

    const payoutRows = await m
      .getRepository(OrganizerPayout)
      .createQueryBuilder('payout')
      .select('payout.status', 'status')
      .addSelect('COALESCE(SUM(payout.amountCentavos), 0)', 'total')
      .where('payout.organizationId = :orgId', { orgId })
      .groupBy('payout.status')
      .getRawMany();

    const totalFor = (status: OrganizerPayoutStatus) =>
      Number(payoutRows.find((r) => r.status === status)?.total ?? 0);

    const netCentavos = Number(earned?.net ?? 0);
    const onHoldCentavos = Number(earned?.hold ?? 0);
    const paidOutCentavos = totalFor(OrganizerPayoutStatus.SUCCEEDED);
    // A pending payout (including one flagged needs_review) keeps its amount reserved.
    const pendingPayoutCentavos = totalFor(OrganizerPayoutStatus.PENDING);

    return {
      netCentavos,
      onHoldCentavos,
      paidOutCentavos,
      pendingPayoutCentavos,
      availableCentavos: Math.max(netCentavos - onHoldCentavos - paidOutCentavos - pendingPayoutCentavos, 0),
    };
  }

  async getSummary(orgId: string, manager?: EntityManager): Promise<EarningsSummary> {
    const m = manager ?? this.dataSource.manager;

    const totals = await m
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin(Event, 'event', 'event.id = payment.eventId')
      .select('COUNT(payment.id)', 'cnt')
      .addSelect('COALESCE(SUM(payment.amountCentavos), 0)', 'gross')
      .addSelect('COALESCE(SUM(ROUND(payment.platformFee * 100)), 0)', 'fees')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.RUNNER_REGISTRATION })
      .andWhere('payment.status = :status', { status: PaymentStatus.PAID })
      .getRawOne();

    const balance = await this.getBalance(orgId, m);

    return {
      currency: 'PHP',
      paymentCount: Number(totals?.cnt ?? 0),
      totalPayments: money(Number(totals?.gross ?? 0)),
      platformFees: money(Number(totals?.fees ?? 0)),
      netEarnings: money(balance.netCentavos),
      onHold: money(balance.onHoldCentavos),
      paidOut: money(balance.paidOutCentavos),
      pendingPayout: money(balance.pendingPayoutCentavos),
      availableBalance: money(balance.availableCentavos),
    };
  }

  /** Per-event split of the same numbers, newest event first. */
  async getEventBreakdown(orgId: string): Promise<EventEarnings[]> {
    const rows = await this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin(Event, 'event', 'event.id = payment.eventId')
      .select('event.id', 'eventId')
      .addSelect('event.name', 'eventName')
      .addSelect('COUNT(payment.id)', 'cnt')
      .addSelect('COALESCE(SUM(payment.amountCentavos), 0)', 'gross')
      .addSelect('COALESCE(SUM(ROUND(payment.registrationFee * 100)), 0)', 'net')
      .addSelect('COALESCE(SUM(ROUND(payment.platformFee * 100)), 0)', 'fees')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.RUNNER_REGISTRATION })
      .andWhere('payment.status = :status', { status: PaymentStatus.PAID })
      .groupBy('event.id')
      .addGroupBy('event.name')
      .orderBy('event.id', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      eventId: String(r.eventId),
      eventName: r.eventName,
      paymentCount: Number(r.cnt),
      totalPayments: money(Number(r.gross)),
      platformFees: money(Number(r.fees)),
      netEarnings: money(Number(r.net)),
    }));
  }
}
