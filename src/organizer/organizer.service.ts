import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Organization } from '../organizations/entities/organization.entity';
import { Event } from '../events/entities/event.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { Payment } from '../payments/entities/payment.entity';
import { PaymongoService } from '../payments/paymongo.service';
import { OrganizerPayoutAccount } from './entities/organizer-payout-account.entity';
import { encryptAccountNumber } from '../utils/payout-crypto';
import { UpsertPayoutAccountDto } from './dto/upsert-payout-account.dto';
import {
  EventStatus,
  OrganizerPayoutStatus,
  PayoutAccountStatus,
  RegistrationStatus,
} from '../common/enums';
import { OrganizerEarningsService } from './organizer-earnings.service';
import { OrganizerPayout } from './entities/organizer-payout.entity';

/**
 * Read-only, organizer-scoped aggregates and lists for the organizer console.
 *
 * Every query is scoped to the CALLER's own organization, resolved from the
 * authenticated user - never from a client-supplied organization id - so
 * these endpoints can't be used to read another organizer's data.
 */
@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly paymongo: PaymongoService,
    private readonly earnings: OrganizerEarningsService,
  ) {}

  async orgIdFor(userId: string): Promise<string | null> {
    const org = await this.dataSource
      .getRepository(Organization)
      .findOne({ where: { ownerUserId: userId } });
    return org?.id ?? null;
  }

  async getOverview(userId: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) {
      return {
        activeEvents: 0,
        totalRegistrations: 0,
        registrationRevenue: 0,
        platformFees: 0,
        totalPayments: 0,
        netEarnings: 0,
        availableBalance: 0,
      };
    }

    const activeEvents = await this.dataSource
      .getRepository(Event)
      .createQueryBuilder('event')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('event.status IN (:...statuses)', {
        statuses: [EventStatus.PUBLISHED, EventStatus.REG_OPEN],
      })
      .getCount();

    const totalRegistrations = await this.dataSource
      .getRepository(Registration)
      .createQueryBuilder('registration')
      .innerJoin('registration.event', 'event')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('registration.status IN (:...statuses)', {
        statuses: [
          RegistrationStatus.REGISTERED,
          RegistrationStatus.CHECKED_IN,
          RegistrationStatus.COMPLETED,
        ],
      })
      .getCount();

    // Matched through payments.event_id (not registrations), so guest group payments are included,
    // and restricted to runner payments so the organizer's own event-creation fee is never counted.
    const summary = await this.earnings.getSummary(orgId);

    return {
      activeEvents,
      totalRegistrations,
      // Existing keys, same meaning (pesos): registration fees collected, and the platform's cut.
      registrationRevenue: Number(summary.netEarnings.amount),
      platformFees: Number(summary.platformFees.amount),
      // New: everything runners were charged, what is the organizer's share (excl. platform fee),
      // and how much of that can be withdrawn right now.
      totalPayments: Number(summary.totalPayments.amount),
      netEarnings: Number(summary.netEarnings.amount),
      availableBalance: Number(summary.availableBalance.amount),
    };
  }

  async listParticipants(userId: string, eventId?: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) return [];

    const qb = this.dataSource
      .getRepository(Registration)
      .createQueryBuilder('registration')
      .innerJoinAndSelect('registration.event', 'event')
      .leftJoinAndSelect('registration.category', 'category')
      .where('event.organizationId = :orgId', { orgId })
      .orderBy('registration.id', 'DESC');
    if (eventId) qb.andWhere('event.id = :eventId', { eventId });

    const rows = await qb.getMany();
    // qrToken is a bearer credential for check-in; organizers use the
    // check-in flow rather than reading it, so don't expose it here.
    return rows.map(({ qrToken: _qrToken, ...r }) => r);
  }

  async listPayments(userId: string, eventId?: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) return [];

    const qb = this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoinAndSelect('payment.registration', 'registration')
      .innerJoinAndSelect('registration.event', 'event')
      .where('event.organizationId = :orgId', { orgId })
      .orderBy('payment.createdAt', 'DESC');
    if (eventId) qb.andWhere('event.id = :eventId', { eventId });

    const rows = await qb.getMany();
    return rows.map((p) => {
      const { qrToken: _qrToken, ...registration } = p.registration;
      return { ...p, registration };
    });
  }

  // --- Payout account ----------------------------------------------------------------------
  // One payout account per organization. The full account number is never returned by any of
  // these methods — only `maskedAccountNumber` (built from the last-4 digits stored in
  // plaintext) ever leaves this service. See OrganizerPayoutAccount for the storage rationale.

  /** AES-256-GCM encrypts a raw account number and extracts its last 4 digits (see payout-crypto.ts). */
  private encryptAccountNumber(raw: string): { encrypted: string; last4: string } {
    const secret = this.configService.get<string>('PAYOUT_ENCRYPTION_SECRET');
    if (!secret) {
      throw new BadRequestException(
        'Payout accounts are not configured on this server (missing PAYOUT_ENCRYPTION_SECRET).',
      );
    }
    return encryptAccountNumber(raw, secret);
  }

  private toPublicPayoutAccount(row: OrganizerPayoutAccount) {
    return {
      id: row.id,
      type: row.type,
      provider: row.provider,
      accountHolderName: row.accountHolderName,
      maskedAccountNumber: `•••• •••• ${row.accountNumberLast4}`,
      bankCode: row.bankCode,
      status: row.status,
      // The PayMongo linked account this payout account is connected to. Payouts need `connected`.
      paymongo: {
        connected: !!row.paymongoAccountId,
        accountId: row.paymongoAccountId,
        activationStatus: row.paymongoActivationStatus,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** `null` when the organizer has no payout account yet — not a 404, same convention as GET /organizations/mine. */
  async getPayoutAccount(userId: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) return null;
    const row = await this.dataSource
      .getRepository(OrganizerPayoutAccount)
      .findOne({ where: { organizationId: orgId } });
    return row ? this.toPublicPayoutAccount(row) : null;
  }

  async createPayoutAccount(userId: string, dto: UpsertPayoutAccountDto) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) {
      throw new BadRequestException(
        'Create an organization before adding a payout account.',
      );
    }
    const repo = this.dataSource.getRepository(OrganizerPayoutAccount);
    const existing = await repo.findOne({ where: { organizationId: orgId } });
    if (existing) {
      throw new BadRequestException(
        'A payout account already exists for this organization — use PATCH to update it.',
      );
    }
    if (!dto.accountNumber) {
      throw new BadRequestException(
        'accountNumber is required when adding a payout account.',
      );
    }
    const { encrypted, last4 } = this.encryptAccountNumber(dto.accountNumber);
    const row = repo.create({
      organizationId: orgId,
      type: dto.type,
      provider: dto.provider,
      accountHolderName: dto.accountHolderName,
      accountNumberEncrypted: encrypted,
      accountNumberLast4: last4,
      bankCode: dto.bankCode ? dto.bankCode.toUpperCase() : null,
      status: PayoutAccountStatus.PENDING,
    });
    await repo.save(row);

    // Connect it to PayMongo straight away (POST /v2/accounts). The local account is already
    // saved, so if PayMongo is down this is not lost: the response says `paymongo.connected:
    // false` and POST /organizer/payout-account/connect retries it.
    try {
      await this.linkToPaymongo(orgId);
    } catch (err: any) {
      this.logger.warn(`Payout account ${row.id} saved but not connected to PayMongo yet: ${err?.message}`);
    }
    return this.toPublicPayoutAccount(await repo.findOneOrFail({ where: { id: row.id } }));
  }

  async updatePayoutAccount(userId: string, dto: UpsertPayoutAccountDto) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) {
      throw new NotFoundException('No payout account found for this organization.');
    }
    const repo = this.dataSource.getRepository(OrganizerPayoutAccount);
    const existing = await repo.findOne({ where: { organizationId: orgId } });
    if (!existing) {
      throw new NotFoundException('No payout account found for this organization.');
    }

    existing.type = dto.type;
    existing.provider = dto.provider;
    existing.accountHolderName = dto.accountHolderName;
    if (dto.bankCode) existing.bankCode = dto.bankCode.toUpperCase();
    // Changing the account details (not just re-saving the same ones) means it hasn't actually
    // been verified against the new details yet.
    existing.status = PayoutAccountStatus.PENDING;
    if (dto.accountNumber) {
      const { encrypted, last4 } = this.encryptAccountNumber(dto.accountNumber);
      existing.accountNumberEncrypted = encrypted;
      existing.accountNumberLast4 = last4;
    }
    await repo.save(existing);
    return this.toPublicPayoutAccount(existing);
  }

  async deletePayoutAccount(userId: string): Promise<void> {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) return;
    const inFlight = await this.dataSource.getRepository(OrganizerPayout).count({
      where: { organizationId: orgId, status: OrganizerPayoutStatus.PENDING },
    });
    if (inFlight > 0) {
      throw new BadRequestException(
        'You have a payout in progress. Wait for it to finish before removing this payout account.',
      );
    }
    await this.dataSource
      .getRepository(OrganizerPayoutAccount)
      .delete({ organizationId: orgId });
  }

  // --- PayMongo linked account ---------------------------------------------------------------

  /** (Re)tries creating the PayMongo linked account. Safe to call repeatedly: it never makes a second one. */
  async connectPayoutAccount(userId: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) throw new NotFoundException('No payout account found for this organization.');
    await this.linkToPaymongo(orgId);
    return this.getPayoutAccount(userId);
  }

  /** Pulls the linked account's current activation status from PayMongo (GET /v2/accounts/:id). */
  async refreshPayoutAccount(userId: string) {
    const orgId = await this.orgIdFor(userId);
    const repo = this.dataSource.getRepository(OrganizerPayoutAccount);
    const row = orgId ? await repo.findOne({ where: { organizationId: orgId } }) : null;
    if (!row) throw new NotFoundException('No payout account found for this organization.');
    if (!row.paymongoAccountId) {
      throw new BadRequestException('This payout account is not connected to PayMongo yet.');
    }
    const linked = await this.paymongo.getLinkedAccount(row.paymongoAccountId);
    row.paymongoActivationStatus = linked.activationStatus;
    row.status = OrganizerService.statusFor(linked.activationStatus);
    await repo.save(row);
    return this.toPublicPayoutAccount(row);
  }

  /**
   * Creates the PayMongo linked (child) account for this organization's payout account and stores
   * its id. The payout-account row is locked for the duration, so a double click or two tabs can't
   * create two child accounts (PayMongo has no way to delete one).
   */
  private async linkToPaymongo(orgId: string): Promise<void> {
    if (!this.paymongo.isConfigured()) {
      throw new ServiceUnavailableException('Online payments are not configured');
    }
    await this.dataSource.transaction(async (manager) => {
      const account = await manager
        .getRepository(OrganizerPayoutAccount)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.organizationId = :orgId', { orgId })
        .getOne();
      if (!account) throw new NotFoundException('No payout account found for this organization.');
      if (account.paymongoAccountId) return; // already connected

      const linked = await this.paymongo.createLinkedAccount('merchant');
      account.paymongoAccountId = linked.id;
      account.paymongoActivationStatus = linked.activationStatus;
      account.paymongoConnectedAt = new Date();
      account.status = OrganizerService.statusFor(linked.activationStatus);
      try {
        await manager.save(OrganizerPayoutAccount, account);
      } catch (err: any) {
        // The child account now exists at PayMongo but we failed to record it.
        this.logger.error(`PayMongo account ${linked.id} was created for org ${orgId} but could not be saved`);
        throw err;
      }
    });
  }

  /** activated -> verified, declined -> failed, anything else (pending / under_review) -> pending. */
  private static statusFor(activationStatus: string | null): PayoutAccountStatus {
    if (activationStatus === 'activated') return PayoutAccountStatus.VERIFIED;
    if (activationStatus === 'declined') return PayoutAccountStatus.FAILED;
    return PayoutAccountStatus.PENDING;
  }
}