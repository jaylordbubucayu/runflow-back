import { HttpException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { OrganizerFeeConfig } from '../organizer-fee/entities/organizer-fee.entity';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentPurpose, PaymentStatus } from '../common/enums';
import { pesosToCentavos } from '../common/services/money.util';
import { SetOrganizerFeeDto } from './dto/set-organizer-fee.dto';

export interface OrganizerFee {
  configId: string;
  amountCentavos: number;
  currency: string;
  description: string | null;
}

/**
 * Owns two things only: what the organizer's event fee currently is, and whether a given event has
 * satisfied it. It depends on repositories alone, so EventsModule can use it to gate publishing
 * without importing the (much larger) PaymentsModule.
 */
@Injectable()
export class OrganizerFeeService {
  constructor(
    @InjectRepository(OrganizerFeeConfig) private readonly configRepo: Repository<OrganizerFeeConfig>,
    @InjectRepository(Payment) private readonly paymentsRepo: Repository<Payment>,
    private readonly dataSource: DataSource,
  ) {}

  /** The fee in force right now, or null when no fee is configured (=> publishing is free). */
  async getActiveFee(): Promise<OrganizerFee | null> {
    const row = await this.configRepo.findOne({
      where: { isActive: true, effectiveFrom: LessThanOrEqual(new Date()) },
      order: { effectiveFrom: 'DESC', id: 'DESC' },
    });
    if (!row || row.amountCentavos <= 0) return null;
    return {
      configId: row.id,
      amountCentavos: row.amountCentavos,
      currency: row.currency,
      description: row.description,
    };
  }

  /** Replaces the active fee. Existing payments keep the amount they were charged. */
  async setFee(dto: SetOrganizerFeeDto, adminUserId?: string): Promise<OrganizerFee | null> {
    const amountCentavos = pesosToCentavos(dto.amountPesos);
    return this.dataSource.transaction(async (manager) => {
      await manager.update(OrganizerFeeConfig, { isActive: true }, { isActive: false });
      if (amountCentavos <= 0) return null; // fee switched off
      const saved = await manager.save(
        manager.create(OrganizerFeeConfig, {
          amountCentavos,
          currency: 'PHP',
          description: dto.description ?? null,
          isActive: true,
          effectiveFrom: new Date(),
          createdByUserId: adminUserId ?? null,
        }),
      );
      return {
        configId: saved.id,
        amountCentavos: saved.amountCentavos,
        currency: saved.currency,
        description: saved.description,
      };
    });
  }

  /** The PAID fee payment for an event, if any (at most one can exist — see the migration). */
  findPaidFee(eventId: string): Promise<Payment | null> {
    return this.paymentsRepo.findOne({
      where: {
        purpose: PaymentPurpose.ORGANIZER_EVENT_CREATION,
        eventId,
        status: PaymentStatus.PAID,
      },
    });
  }

  /**
   * Publishing gate. Passes when no fee is configured or this event's fee has been verified PAID
   * by PayMongo; otherwise throws 402. Only a PAID row counts — a pending link, a redirect back
   * from checkout, or anything the browser says is not accepted.
   */
  async assertSatisfied(eventId: string): Promise<void> {
    const fee = await this.getActiveFee();
    if (!fee) return;
    if (await this.findPaidFee(eventId)) return;
    throw new HttpException(
      {
        statusCode: 402,
        error: 'Payment Required',
        code: 'PLATFORM_FEE_REQUIRED',
        message: 'The platform fee for this event must be paid before it can be published.',
      },
      402,
    );
  }
}