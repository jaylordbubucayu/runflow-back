import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { EventStatus, PaymentPurpose, PaymentStatus } from '../common/enums';
import { centavosToPesos } from '../common/services/money.util';
import { EventsService } from '../events/events.service';
import { PaymentsService, PaymentView } from 'src/payments/payments.service';
import { Payment } from 'src/payments/entities/payment.entity';
import { PaymongoService } from 'src/payments/paymongo.service';
import { PaymentSettlementService } from 'src/payments/payment-settlement.service';
import { PaymentLedgerService } from 'src/payments/payment-ledger.service';
import { OrganizerFeeService } from 'src/organizer-fee/organizer-fee.service';


export type OrganizerFeeStatus = 'not_required' | 'unpaid' | 'pending' | 'paid' | 'expired' | 'failed';

export interface OrganizerFeeSummary {
  eventId: string;
  eventStatus: EventStatus;
  required: boolean;
  /** What is/was charged. Once paid this is the amount actually paid, not today's configured fee. */
  fee: { amountCentavos: number; amount: string; currency: string; description: string | null } | null;
  feeStatus: OrganizerFeeStatus;
  /** True when the fee is settled AND the event is still a draft the organizer can publish. */
  canPublish: boolean;
  payment: PaymentView | null;
  attempts: number;
}

/**
 * Organizer platform-fee payments (purpose ORGANIZER_EVENT_CREATION).
 *
 * In this app an event is built step by step as a DRAFT (already persisted, so nothing is lost if
 * checkout is abandoned) and then published. The fee is charged at the publish step: paying
 * unlocks `POST /events/:id/publish`, it does not publish. Runner registration prices are never
 * involved.
 */
@Injectable()
export class OrganizerEventPaymentsService {
  constructor(
    @InjectRepository(Event) private readonly eventsRepo: Repository<Event>,
    @InjectRepository(Organization) private readonly orgsRepo: Repository<Organization>,
    @InjectRepository(Payment) private readonly paymentsRepo: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly paymongo: PaymongoService,
    private readonly settlement: PaymentSettlementService,
    private readonly ledger: PaymentLedgerService,
    private readonly fees: OrganizerFeeService,
    private readonly eventsService: EventsService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  /** The fee the frontend should display. The amount only ever comes from here. */
  async getQuote() {
    const fee = await this.fees.getActiveFee();
    return {
      required: !!fee,
      amountCentavos: fee?.amountCentavos ?? 0,
      amount: centavosToPesos(fee?.amountCentavos ?? 0),
      currency: fee?.currency ?? 'PHP',
      description: fee?.description ?? null,
    };
  }

  async getStatus(eventId: string, userId: string): Promise<OrganizerFeeSummary> {
    const event = await this.loadOwnedEvent(eventId, userId);
    return this.summarise(event);
  }

  async createPaymentLink(eventId: string, userId: string) {
    const event = await this.loadOwnedEvent(eventId, userId);
    if (event.status !== EventStatus.DRAFT) {
      throw new BadRequestException('Only draft events need a platform fee payment');
    }
    await this.eventsService.assertReadyToPublish(event.id);

    const fee = await this.fees.getActiveFee();
    if (!fee) throw new BadRequestException('No platform fee is required for this event');
    if (await this.fees.findPaidFee(event.id)) {
      throw new ConflictException('The platform fee for this event has already been paid');
    }

    const ttlMs = Number(this.config.get('ORGANIZER_PAYMENT_TTL_MINUTES') ?? 1440) * 60_000;
    let toArchive: Payment | null = null;

    await this.dataSource.transaction(async (manager) => {
      // One checkout at a time per event: retries and double-clicks cannot create two live links.
      const locked = await manager
        .getRepository(Event)
        .createQueryBuilder('e')
        .setLock('pessimistic_write')
        .where('e.id = :id', { id: event.id })
        .getOne();
      if (!locked) throw new NotFoundException('Event not found');

      const paid = await manager.findOne(Payment, {
        where: { purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION, eventId: event.id, status: PaymentStatus.PAID },
      });
      if (paid) throw new ConflictException('The platform fee for this event has already been paid');

      const existing = await manager.findOne(Payment, {
        where: { purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION, eventId: event.id, status: PaymentStatus.PENDING },
        order: { id: 'DESC' },
      });
      if (existing) {
        const expired = !!existing.expiresAt && existing.expiresAt.getTime() <= Date.now();
        if (existing.amountCentavos === fee.amountCentavos && existing.checkoutUrl && !expired) {
          return; // the existing link is still exactly right: reuse it
        }
        if (await this.settlement.supersede(manager, existing, expired ? 'link expired' : 'fee changed')) {
          toArchive = existing;
        }
      }

      const pesos = centavosToPesos(fee.amountCentavos);
      const payment = await manager.save(
        manager.create(Payment, {
          purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION,
          registrationId: null,
          eventId: String(event.id),
          organizationId: String(event.organizationId),
          ownerUserId: String(userId),
          registrationFee: '0.00',
          platformFee: pesos,
          totalAmount: pesos,
          amountCentavos: fee.amountCentavos, // snapshot: later fee changes never rewrite history
          currency: fee.currency,
          status: PaymentStatus.PENDING,
          expiresAt: new Date(Date.now() + ttlMs),
        }),
      );

      const link = await this.paymongo.createPaymentLink({
        amountCentavos: fee.amountCentavos,
        currency: fee.currency,
        description: `RunFlow platform fee — ${event.name}`,
        remarks: `RUNFLOW-PAYMENT-${payment.id}`,
        metadata: { runflow_payment_id: `RUNFLOW-PAYMENT-${payment.id}`, purpose: 'organizer_event_creation' },
      });
      payment.providerCheckoutId = link.id;
      payment.providerReferenceNumber = link.referenceNumber;
      payment.checkoutUrl = link.checkoutUrl;
      await manager.save(Payment, payment);
      await this.ledger.log(manager, payment.id, null, PaymentStatus.PENDING, 'api', 'platform fee link created', {
        linkId: link.id,
      });
    });

    if (toArchive) await this.settlement.archiveQuietly(toArchive);
    return this.summarise(event);
  }

  // ---- internals -------------------------------------------------------------------------------

  private async summarise(event: Event): Promise<OrganizerFeeSummary> {
    const activeFee = await this.fees.getActiveFee();
    const attempts = await this.paymentsRepo.count({
      where: { purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION, eventId: event.id },
    });
    let paid = await this.fees.findPaidFee(event.id);
    let latest =
      paid ??
      (await this.paymentsRepo.findOne({
        where: { purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION, eventId: event.id },
        order: { id: 'DESC' },
      }));

    // Settle / expire a pending attempt on read, so a missed webhook cannot strand the organizer.
    if (latest && latest.status === PaymentStatus.PENDING) {
      latest = await this.payments.freshen(latest);
      if (latest.status === PaymentStatus.PAID) paid = latest;
    }

    let feeStatus: OrganizerFeeStatus;
    if (paid) feeStatus = 'paid';
    else if (!activeFee) feeStatus = 'not_required';
    else if (!latest || latest.status === PaymentStatus.CANCELLED) feeStatus = 'unpaid';
    else if (latest.status === PaymentStatus.PENDING) feeStatus = 'pending';
    else if (latest.status === PaymentStatus.EXPIRED) feeStatus = 'expired';
    else feeStatus = 'failed';

    const shown = paid ? { amountCentavos: paid.amountCentavos!, currency: paid.currency } : activeFee;
    return {
      eventId: String(event.id),
      eventStatus: event.status,
      required: !!activeFee || !!paid,
      fee: shown
        ? {
            amountCentavos: shown.amountCentavos,
            amount: centavosToPesos(shown.amountCentavos),
            currency: shown.currency,
            description: activeFee?.description ?? null,
          }
        : null,
      feeStatus,
      canPublish: (feeStatus === 'paid' || feeStatus === 'not_required') && event.status === EventStatus.DRAFT,
      payment: latest ? this.payments.toView(latest) : null,
      attempts,
    };
  }

  /** The event must belong to the caller's organization. */
  private async loadOwnedEvent(eventId: string, userId: string): Promise<Event> {
    const org = await this.orgsRepo.findOne({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('No organization found for user');
    const event = await this.eventsRepo.findOne({ where: { id: eventId } });
    if (!event || String(event.organizationId) !== String(org.id)) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }
}