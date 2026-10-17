import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PlatformFeeConfig } from './entities/platform-fee-config.entity';
import {
  EventStatus,
  FeeType,
  PaymentPurpose,
  PaymentStatus,
  RegistrationStatus,
  UserRole,
} from '../common/enums';
import { Registration } from '../registrations/entities/registration.entity';
import { pesosToCentavos, centavosToPesos } from '../common/services/money.util';
import { SetFeeConfigDto } from './dto/set-fee-config.dto';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymongoService } from './paymongo.service';

export interface FeeBreakdown {
  registrationFee: string;
  platformFee: string;
  total: string;
}

/** Who is asking. Comes from the JWT (see JwtStrategy) — never from the request body. */
export interface Actor {
  id: string;
  role: string;
}

/** What the frontend is allowed to know about a payment. No provider internals, no raw payloads. */
export interface PaymentView {
  id: string;
  purpose: PaymentPurpose;
  status: PaymentStatus;
  provider: 'paymongo';
  registrationId: string | null;
  eventId: string | null;
  amountCentavos: number | null;
  currency: string;
  registrationFee: string;
  platformFee: string;
  totalAmount: string;
  paymentMethod: string | null;
  /** Only present while the payment can still be paid. */
  checkoutUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

const OPEN_EVENT_STATUSES = [EventStatus.REG_OPEN, EventStatus.PUBLISHED];

/**
 * Runner registration payments (purpose RUNNER_REGISTRATION). The organizer's platform fee lives
 * in OrganizerEventPaymentsService; the two share PaymongoService and the settlement/ledger
 * services but never each other's rows.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment) private readonly paymentsRepo: Repository<Payment>,
    @InjectRepository(PlatformFeeConfig)
    private readonly feeConfigRepo: Repository<PlatformFeeConfig>,
    private readonly dataSource: DataSource,
    private readonly paymongo: PaymongoService,
    private readonly settlement: PaymentSettlementService,
    private readonly ledger: PaymentLedgerService,
    private readonly config: ConfigService,
  ) {}

  // ---- fee calculation (unchanged: the runner-side platform surcharge) --------------------------

  async calculateFee(registrationFee: number, organizationId?: string): Promise<FeeBreakdown> {
    let config: PlatformFeeConfig | null = null;

    if (organizationId) {
      config = await this.feeConfigRepo.findOne({ where: { organizationId, isActive: true } });
    }
    if (!config) {
      config = await this.feeConfigRepo.findOne({ where: { organizationId: IsNull(), isActive: true } });
    }

    const feeCentavos = pesosToCentavos(registrationFee);
    let platformFeeCentavos = 0;

    if (config) {
      if (config.feeType === FeeType.FIXED) {
        platformFeeCentavos = pesosToCentavos(config.fixedAmount ?? 0);
      } else if (config.feeType === FeeType.PERCENTAGE) {
        platformFeeCentavos = Math.round((feeCentavos * Number(config.percentage ?? 0)) / 100);
      } else if (config.feeType === FeeType.FIXED_PLUS_PERCENTAGE) {
        platformFeeCentavos =
          pesosToCentavos(config.fixedAmount ?? 0) +
          Math.round((feeCentavos * Number(config.percentage ?? 0)) / 100);
      }
    }

    return {
      registrationFee: centavosToPesos(feeCentavos),
      platformFee: centavosToPesos(platformFeeCentavos),
      total: centavosToPesos(feeCentavos + platformFeeCentavos),
    };
  }

  // ---- checkout (single registration) ---------------------------------------------------------

  /**
   * Creates — or reuses — the PayMongo link for one registration.
   *
   * The amount is NEVER taken from the request: it is the category price in MySQL, minus any
   * discount that was locked onto the registration when it was created, plus the runner-side
   * platform fee. Only the registration's owner (or an admin) may start its payment.
   */
  async createCheckout(registrationId: string, actor: Actor) {
    const reg = await this.dataSource.getRepository(Registration).findOne({
      where: { id: registrationId },
      relations: ['category', 'event'],
    });
    // 404 (not 403) for someone else's registration so ids can't be probed.
    if (!reg || !(this.isAdmin(actor) || String(reg.runnerUserId) === String(actor.id))) {
      throw new NotFoundException('Registration not found');
    }
    if (reg.groupId) {
      throw new BadRequestException('This registration belongs to a group. Use group checkout instead.');
    }
    this.assertPayable(reg);
    return this.checkoutFor([reg], 'single', actor.id);
  }

  /**
   * Checkout for a whole guest registration group: ONE payment covers every registration sharing
   * `groupId`, with the platform fee computed once on the combined total. The groupId (a random
   * UUID only the registrant holds) is the credential, since guests have no account.
   */
  async createGroupCheckout(groupId: string) {
    const regs = await this.dataSource.getRepository(Registration).find({
      where: { groupId },
      relations: ['category', 'event'],
    });
    if (!regs.length) throw new NotFoundException('No registrations found for this group');
    if (regs.some((r) => r.status !== RegistrationStatus.PENDING_PAYMENT)) {
      throw new BadRequestException('One or more registrations in this group are not awaiting payment');
    }
    regs.forEach((r) => this.assertPayable(r));
    return this.checkoutFor(regs, 'group', null);
  }

  private assertPayable(reg: Registration) {
    if (reg.status === RegistrationStatus.CANCELLED) {
      throw new BadRequestException('This registration was cancelled');
    }
    if (reg.status !== RegistrationStatus.PENDING_PAYMENT) {
      throw new ConflictException('This registration is already paid');
    }
    // The registration window was checked when the slot was reserved; a held reservation is not
    // lost at the deadline, but an event that is no longer published/open takes no new payments.
    if (!OPEN_EVENT_STATUSES.includes(reg.event.status)) {
      throw new BadRequestException('This event is not open for registration');
    }
  }

  private async checkoutFor(regs: Registration[], mode: 'single' | 'group', ownerUserId: string | null) {
    const event = regs[0].event;

    // Price comes from the database. `discountAmount` was computed server-side at registration.
    const registrationCentavos = regs.reduce((sum, r) => {
      const price = pesosToCentavos(r.category.price);
      const discount = pesosToCentavos(r.discountAmount ?? 0);
      return sum + Math.max(price - discount, 0);
    }, 0);

    // Free registration: no PayMongo, no platform fee — confirm directly.
    if (registrationCentavos === 0) {
      await this.settlement.confirmFreeRegistrations(regs.map((r) => r.id));
      return {
        free: true,
        status: PaymentStatus.PAID,
        paymentId: null,
        checkoutUrl: null,
        registrationIds: regs.map((r) => r.id),
      };
    }

    const fee = await this.calculateFee(Number(centavosToPesos(registrationCentavos)), event.organizationId);
    const totalCentavos = pesosToCentavos(fee.total);
    const ids = regs.map((r) => r.id);
    const ttlMs = Number(this.config.get('RUNNER_PAYMENT_TTL_MINUTES') ?? 60) * 60_000;

    let toArchive: Payment | null = null;

    const result = await this.dataSource.transaction(async (manager) => {
      // Serialise concurrent checkouts for the same registration(s): a double-click or two tabs
      // can never create two live links.
      const locked = await manager
        .getRepository(Registration)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id IN (:...ids)', { ids })
        .getMany();
      if (locked.length !== ids.length || locked.some((r) => r.status !== RegistrationStatus.PENDING_PAYMENT)) {
        throw new ConflictException('This registration is no longer awaiting payment');
      }

      const existing =
        mode === 'single'
          ? await manager.findOne(Payment, {
              where: {
                registrationId: ids[0],
                purpose: PaymentPurpose.RUNNER_REGISTRATION,
                status: PaymentStatus.PENDING,
              },
              order: { id: 'DESC' },
            })
          : locked[0].paymentId
            ? await manager.findOne(Payment, { where: { id: locked[0].paymentId, status: PaymentStatus.PENDING } })
            : null;

      if (existing) {
        const expired = !!existing.expiresAt && existing.expiresAt.getTime() <= Date.now();
        const sameFor =
          existing.amountCentavos === totalCentavos &&
          String(existing.eventId) === String(event.id) &&
          !!existing.checkoutUrl &&
          !expired;
        // Reuse only a link that matches THIS exact pending payment (same amount, same event).
        if (sameFor) return { payment: existing, reused: true };

        if (await this.settlement.supersede(manager, existing, expired ? 'link expired' : 'amount changed')) {
          toArchive = existing;
        }
      }

      const payment = await manager.save(
        manager.create(Payment, {
          purpose: PaymentPurpose.RUNNER_REGISTRATION,
          registrationId: mode === 'single' ? ids[0] : null,
          eventId: String(event.id),
          organizationId: String(event.organizationId),
          ownerUserId,
          registrationFee: fee.registrationFee,
          platformFee: fee.platformFee,
          totalAmount: fee.total,
          amountCentavos: totalCentavos,
          currency: 'PHP',
          status: PaymentStatus.PENDING,
          expiresAt: new Date(Date.now() + ttlMs),
        }),
      );

      // If PayMongo fails, this throws and the whole transaction (incl. the row above) rolls back.
      const link = await this.paymongo.createPaymentLink({
        amountCentavos: totalCentavos,
        description: `${event.name} — registration${regs.length > 1 ? ` (${regs.length} runners)` : ''}`,
        currency: 'PHP',
        remarks: `RUNFLOW-PAYMENT-${payment.id}`,
        metadata: { runflow_payment_id: `RUNFLOW-PAYMENT-${payment.id}`, purpose: 'runner_registration' },
      });
      payment.providerCheckoutId = link.id;
      payment.providerReferenceNumber = link.referenceNumber;
      payment.checkoutUrl = link.checkoutUrl;
      await manager.save(Payment, payment);

      if (mode === 'group') {
        await manager.update(Registration, ids, { paymentId: payment.id });
      }
      await this.ledger.log(manager, payment.id, null, PaymentStatus.PENDING, 'api', 'payment link created', {
        linkId: link.id,
        registrations: ids.length,
      });
      return { payment, reused: false };
    });

    if (toArchive) await this.settlement.archiveQuietly(toArchive);

    const p = result.payment;
    return {
      free: false,
      reused: result.reused,
      paymentId: p.id,
      checkoutUrl: p.checkoutUrl,
      status: p.status,
      amountCentavos: p.amountCentavos,
      currency: p.currency,
      registrationFee: p.registrationFee,
      platformFee: p.platformFee,
      totalAmount: p.totalAmount,
      expiresAt: p.expiresAt,
      participantCount: regs.length,
    };
  }

  /** Called by RegistrationsService.cancel so a cancelled registration can't still be paid for. */
  onRegistrationCancelled(registrationId: string) {
    return this.settlement.onRegistrationCancelled(registrationId);
  }

  // ---- status ---------------------------------------------------------------------------------

  /** One payment, for its owner (or an admin). Settles/expires it first if needed. */
  async getPaymentForActor(id: string, actor: Actor): Promise<PaymentView> {
    const payment = await this.paymentsRepo.findOne({ where: { id } });
    if (!payment || !(await this.canView(payment, actor))) {
      throw new NotFoundException('Payment not found');
    }
    return this.toView(await this.freshen(payment));
  }

  /** The latest attempt for a registration — what the confirmation page polls. Owner/admin only. */
  async getStatusForRegistration(registrationId: string, actor: Actor) {
    const regRepo = this.dataSource.getRepository(Registration);
    const reg = await regRepo.findOne({ where: { id: registrationId } });
    if (!reg || !(this.isAdmin(actor) || String(reg.runnerUserId) === String(actor.id))) {
      throw new NotFoundException('Registration not found');
    }
    const payment = reg.paymentId
      ? await this.paymentsRepo.findOne({ where: { id: reg.paymentId } })
      : await this.paymentsRepo.findOne({
          where: { registrationId, purpose: PaymentPurpose.RUNNER_REGISTRATION },
          order: { id: 'DESC' },
        });

    const fresh = payment ? await this.freshen(payment) : null;
    // Re-read: freshen() may have just confirmed or released the registration.
    const current = await regRepo.findOneOrFail({ where: { id: registrationId } });
    return {
      registrationId,
      registrationStatus: current.status,
      status: this.effectiveStatus(fresh, [current]),
      payment: fresh ? this.toView(fresh) : null,
    };
  }

  /** Guest group status. The group's random UUID is the credential. */
  async getGroupStatus(groupId: string) {
    const regRepo = this.dataSource.getRepository(Registration);
    const first = await regRepo.find({ where: { groupId } });
    if (!first.length) throw new NotFoundException('Group not found');
    const paymentId = first.find((r) => r.paymentId)?.paymentId;
    const payment = paymentId ? await this.paymentsRepo.findOne({ where: { id: paymentId } }) : null;
    const fresh = payment ? await this.freshen(payment) : null;
    const current = await regRepo.find({ where: { groupId } });
    return {
      groupId,
      status: this.effectiveStatus(fresh, current),
      payment: fresh ? this.toView(fresh) : null,
      registrations: current.map((r) => ({ id: r.id, status: r.status })),
    };
  }

  /**
   * 'unpaid' = no payment attempt exists yet. Free registrations have no payment row, so they are
   * 'paid' once every registration is past PENDING_PAYMENT.
   */
  private effectiveStatus(payment: Payment | null, regs: Registration[]): PaymentStatus | 'unpaid' {
    if (payment) return payment.status;
    const live = regs.filter((r) => r.status !== RegistrationStatus.CANCELLED);
    if (live.length && live.every((r) => r.status !== RegistrationStatus.PENDING_PAYMENT)) return PaymentStatus.PAID;
    return 'unpaid';
  }

  private async canView(payment: Payment, actor: Actor): Promise<boolean> {
    if (this.isAdmin(actor)) return true;
    if (payment.ownerUserId && String(payment.ownerUserId) === String(actor.id)) return true;
    if (payment.purpose === PaymentPurpose.RUNNER_REGISTRATION) {
      const reg = await this.dataSource.getRepository(Registration).findOne({
        where: payment.registrationId ? { id: payment.registrationId } : { paymentId: payment.id },
      });
      return !!reg && String(reg.runnerUserId) === String(actor.id);
    }
    return false;
  }

  /** Lazily expires an overdue link, and asks PayMongo about a pending one (covers late webhooks). */
  async freshen(payment: Payment): Promise<Payment> {
    if (payment.status !== PaymentStatus.PENDING) return payment;
    if (payment.expiresAt && payment.expiresAt.getTime() <= Date.now()) {
      const settled = await this.settlement.refreshFromProvider(payment.id, { force: true });
      if (settled.status === PaymentStatus.PENDING) await this.settlement.expire(payment.id);
      return this.paymentsRepo.findOneOrFail({ where: { id: payment.id } });
    }
    return this.settlement.refreshFromProvider(payment.id);
  }

  toView(p: Payment): PaymentView {
    return {
      id: p.id,
      purpose: p.purpose,
      status: p.status,
      provider: 'paymongo',
      registrationId: p.registrationId,
      eventId: p.eventId,
      amountCentavos: p.amountCentavos,
      currency: p.currency,
      registrationFee: p.registrationFee,
      platformFee: p.platformFee,
      totalAmount: p.totalAmount,
      paymentMethod: p.paymentMethod,
      checkoutUrl: p.status === PaymentStatus.PENDING ? p.checkoutUrl : null,
      expiresAt: p.expiresAt,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    };
  }

  private isAdmin(actor: Actor) {
    return actor.role === UserRole.ADMIN;
  }

  // ---- reporting (runner payments only unless asked otherwise) ----------------------------------

  async getTransactionsForOrganizer(orgId: string, _filters: any) {
    return this.paymentsRepo
      .createQueryBuilder('payment')
      .innerJoin('payment.registration', 'registration')
      .innerJoin('registration.event', 'event')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.RUNNER_REGISTRATION })
      .orderBy('payment.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Defaults to runner payments so the existing admin screen is unchanged. Pass
   * `purpose=organizer_event_creation` (or `purpose=all`) to see organizer platform fees.
   */
  async getTransactionsForAdmin(filters: any) {
    const purpose: string = filters?.purpose ?? PaymentPurpose.RUNNER_REGISTRATION;
    const qb = this.paymentsRepo
      .createQueryBuilder('payment')
      .leftJoinAndSelect('payment.registration', 'registration')
      .leftJoinAndSelect('registration.event', 'event')
      .leftJoinAndSelect('event.organization', 'organization')
      .orderBy('payment.createdAt', 'DESC');
    if (purpose !== 'all') {
      qb.andWhere('payment.purpose = :purpose', { purpose });
    }
    if (filters?.status) {
      qb.andWhere('payment.status = :status', { status: filters.status });
    }
    return qb.getMany();
  }

  /** Payments that took money the system could not apply cleanly (duplicate, mismatch, late). */
  getReconciliationQueue() {
    return this.paymentsRepo.find({ where: { needsReconciliation: true }, order: { updatedAt: 'DESC' }, take: 200 });
  }

  // --- Fee config (owned/written by AdminModule, entity lives here) ---
  async setFeeConfig(dto: SetFeeConfigDto) {
    if (dto.organizationId) {
      await this.feeConfigRepo.update({ organizationId: dto.organizationId }, { isActive: false });
    } else {
      await this.feeConfigRepo.update({ organizationId: IsNull() }, { isActive: false });
    }
    const config = this.feeConfigRepo.create({ ...dto, isActive: true } as any);
    return this.feeConfigRepo.save(config);
  }

  async getFeeConfig(organizationId?: string) {
    if (organizationId) {
      const override = await this.feeConfigRepo.findOne({ where: { organizationId, isActive: true } });
      if (override) return override;
    }
    return this.feeConfigRepo.findOne({ where: { organizationId: IsNull(), isActive: true } });
  }
}