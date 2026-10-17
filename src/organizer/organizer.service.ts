import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { Organization } from '../organizations/entities/organization.entity';
import { Event } from '../events/entities/event.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { Payment } from '../payments/entities/payment.entity';
import { OrganizerPayoutAccount } from './entities/organizer-payout-account.entity';
import { UpsertPayoutAccountDto } from './dto/upsert-payout-account.dto';
import {
  EventStatus,
  PaymentStatus,
  PayoutAccountStatus,
  RegistrationStatus,
} from '../common/enums';

/**
 * Read-only, organizer-scoped aggregates and lists for the organizer console.
 *
 * Every query is scoped to the CALLER's own organization, resolved from the
 * authenticated user - never from a client-supplied organization id - so
 * these endpoints can't be used to read another organizer's data.
 */
@Injectable()
export class OrganizerService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  private async orgIdFor(userId: string): Promise<string | null> {
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

    const money = await this.dataSource
      .getRepository(Payment)
      .createQueryBuilder('payment')
      .innerJoin('payment.registration', 'registration')
      .innerJoin('registration.event', 'event')
      .select('COALESCE(SUM(payment.registrationFee), 0)', 'registrationRevenue')
      .addSelect('COALESCE(SUM(payment.platformFee), 0)', 'platformFees')
      .where('event.organizationId = :orgId', { orgId })
      .andWhere('payment.status = :status', { status: PaymentStatus.PAID })
      .getRawOne();

    return {
      activeEvents,
      totalRegistrations,
      registrationRevenue: Number(money?.registrationRevenue ?? 0),
      platformFees: Number(money?.platformFees ?? 0),
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

  /**
   * AES-256-GCM encrypts a raw account number and separately extracts its last 4 digits (which
   * are stored in plaintext, since that's all the API ever needs to show). The key is derived
   * from PAYOUT_ENCRYPTION_SECRET via scrypt, so the secret in .env can be any string rather than
   * needing to be an exact 32-byte value.
   */
  private encryptAccountNumber(raw: string): { encrypted: string; last4: string } {
    const secret = this.configService.get<string>('PAYOUT_ENCRYPTION_SECRET');
    if (!secret) {
      throw new BadRequestException(
        'Payout accounts are not configured on this server (missing PAYOUT_ENCRYPTION_SECRET).',
      );
    }
    const key = scryptSync(secret, 'runflow-payout-salt', 32);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(raw, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const encrypted = [iv, authTag, ciphertext]
      .map((b) => b.toString('base64'))
      .join(':');
    return { encrypted, last4: raw.replace(/\D/g, '').slice(-4) };
  }

  private toPublicPayoutAccount(row: OrganizerPayoutAccount) {
    return {
      id: row.id,
      type: row.type,
      provider: row.provider,
      accountHolderName: row.accountHolderName,
      maskedAccountNumber: `•••• •••• ${row.accountNumberLast4}`,
      status: row.status,
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
      status: PayoutAccountStatus.PENDING,
    });
    await repo.save(row);
    return this.toPublicPayoutAccount(row);
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
    await this.dataSource
      .getRepository(OrganizerPayoutAccount)
      .delete({ organizationId: orgId });
  }
}