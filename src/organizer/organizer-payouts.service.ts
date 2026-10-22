import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Organization } from '../organizations/entities/organization.entity';
import { PaymongoBatchTransfer, PaymongoService, PaymongoTransfer } from '../payments/paymongo.service';
import { OrganizerPayoutAccount } from './entities/organizer-payout-account.entity';
import { OrganizerPayout } from './entities/organizer-payout.entity';
import { OrganizerEarningsService } from './organizer-earnings.service';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { OrganizerPayoutStatus, PayoutAccountType } from '../common/enums';
import { centavosToPesos } from '../common/services/money.util';
import { decryptAccountNumber } from '../utils/payout-crypto';

/**
 * Sends an organizer's earnings to their payout account with PayMongo Transfer V2
 * (POST /v2/batch_transfers).
 *
 * Money safety, in order:
 *  1. The balance is checked and RESERVED (a PENDING organizer_payouts row) in one transaction
 *     that holds a row lock on the organizer's payout account, so two concurrent requests can
 *     never withdraw the same money.
 *  2. Only after that commits is PayMongo called — never inside the transaction, so a rollback
 *     can't hide a transfer that actually happened.
 *  3. If PayMongo answers 4xx the transfer definitely did not happen and the reservation is
 *     released (FAILED). If the outcome is UNKNOWN (timeout, 5xx), the payout stays reserved and
 *     is flagged `needsReview`; it is never retried automatically, so it cannot be paid twice.
 */
@Injectable()
export class OrganizerPayoutsService {
  private readonly logger = new Logger(OrganizerPayoutsService.name);
  /** payoutId -> last time we asked PayMongo, so status polling can't hammer their API. */
  private readonly lastCheck = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly paymongo: PaymongoService,
    private readonly earnings: OrganizerEarningsService,
  ) {}

  // ---- config ------------------------------------------------------------------------------

  private get minAmountCentavos(): number {
    return Number(this.config.get('PAYOUT_MIN_AMOUNT_CENTAVOS') ?? 10000);
  }

  /** instapay | pesonet | paymongo. InstaPay is fast but capped per transfer; PESONet is not. */
  private get transferProvider(): string {
    return this.config.get<string>('PAYOUT_TRANSFER_PROVIDER') || 'instapay';
  }

  private get requireActivatedAccount(): boolean {
    return String(this.config.get('PAYOUT_REQUIRE_ACTIVATED_ACCOUNT') ?? 'false').toLowerCase() === 'true';
  }

  // ---- reads -------------------------------------------------------------------------------

  async list(userId: string) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) return [];
    const rows = await this.dataSource
      .getRepository(OrganizerPayout)
      .find({ where: { organizationId: orgId }, order: { id: 'DESC' }, take: 50 });

    // Settle pending transfers on read, so a missed status change can't strand an organizer.
    const synced: OrganizerPayout[] = [];
    for (const row of rows) synced.push(await this.syncQuietly(row));
    return synced.map((p) => this.toView(p));
  }

  async refresh(userId: string, payoutId: string) {
    const orgId = await this.orgIdFor(userId);
    const row = orgId
      ? await this.dataSource.getRepository(OrganizerPayout).findOne({ where: { id: payoutId, organizationId: orgId } })
      : null;
    if (!row) throw new NotFoundException('Payout not found');
    return this.toView(await this.syncQuietly(row, { force: true }));
  }

  // ---- request a payout ----------------------------------------------------------------------

  async requestPayout(userId: string, dto: RequestPayoutDto) {
    const orgId = await this.orgIdFor(userId);
    if (!orgId) throw new BadRequestException('Create an organization before requesting a payout.');
    if (!this.paymongo.isTransferConfigured()) {
      throw new ServiceUnavailableException('Payouts are not available right now');
    }
    const secret = this.config.get<string>('PAYOUT_ENCRYPTION_SECRET');
    if (!secret) throw new ServiceUnavailableException('Payouts are not available right now');

    // ---- phase 1: validate + reserve, atomically -------------------------------------------
    const reserved = await this.dataSource.transaction(async (manager) => {
      const account = await manager
        .getRepository(OrganizerPayoutAccount)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.organizationId = :orgId', { orgId })
        .getOne();

      if (!account) throw new BadRequestException('Add a payout account before requesting a payout.');
      if (account.type === PayoutAccountType.CARD) {
        throw new BadRequestException('Cards cannot receive payouts. Use a bank or e-wallet account.');
      }
      if (!account.paymongoAccountId) {
        throw new BadRequestException(
          'Your payout account is not connected to PayMongo yet. Reconnect it first, then try again.',
        );
      }
      if (this.requireActivatedAccount && account.paymongoActivationStatus !== 'activated') {
        throw new BadRequestException('Your PayMongo account is not activated yet.');
      }
      if (!account.bankCode) {
        throw new BadRequestException('Add the bank or e-wallet code (BIC) to your payout account first.');
      }

      const balance = await this.earnings.getBalance(orgId, manager);
      const amountCentavos = dto.amountCentavos ?? balance.availableCentavos;

      if (amountCentavos <= 0) throw new BadRequestException('You have no available balance to withdraw.');
      if (amountCentavos < this.minAmountCentavos) {
        throw new BadRequestException(`The minimum payout is ₱${centavosToPesos(this.minAmountCentavos)}.`);
      }
      if (amountCentavos > balance.availableCentavos) {
        throw new BadRequestException(
          `Amount exceeds your available balance of ₱${centavosToPesos(balance.availableCentavos)}.`,
        );
      }

      let accountNumber: string;
      try {
        accountNumber = decryptAccountNumber(account.accountNumberEncrypted, secret);
      } catch {
        // Wrong PAYOUT_ENCRYPTION_SECRET or corrupted row. Never echo details.
        this.logger.error(`Could not decrypt payout account ${account.id}`);
        throw new ServiceUnavailableException('Payouts are not available right now');
      }

      const payout = await manager.save(
        manager.create(OrganizerPayout, {
          organizationId: String(orgId),
          payoutAccountId: String(account.id),
          amountCentavos,
          currency: 'PHP',
          status: OrganizerPayoutStatus.PENDING,
          provider: this.transferProvider,
          referenceNumber: `RF-PO-${randomUUID()}`,
          destinationBankCode: account.bankCode,
          destinationLast4: account.accountNumberLast4,
          destinationName: account.accountHolderName,
          paymongoAccountId: account.paymongoAccountId,
          requestedByUserId: String(userId),
          needsReview: false,
        }),
      );
      return { payout, account, accountNumber };
    });

    // ---- phase 2: tell PayMongo (outside the transaction) ----------------------------------
    const { payout, account, accountNumber } = reserved;

    let batch: PaymongoBatchTransfer;
    try {
      batch = await this.paymongo.createBatchTransfer([
        {
          amountCentavos: payout.amountCentavos,
          currency: payout.currency,
          provider: payout.provider,
          referenceNumber: payout.referenceNumber,
          purpose: 'RunFlow event payout',
          description: `RunFlow payout ${payout.referenceNumber}`,
          destination: { number: accountNumber, name: account.accountHolderName, bic: account.bankCode! },
          metadata: {
            runflow_payout_id: String(payout.id),
            organization_id: String(orgId),
            paymongo_account_id: String(account.paymongoAccountId),
          },
        },
      ]);
    } catch (err: any) {
      return this.handleSubmitError(payout, err);
    }

    // PayMongo accepted the request. From here on a failure must NOT release the reservation.
    const transfer = this.pickTransfer(batch.transfers, payout);
    if (!transfer) {
      payout.paymongoBatchId = batch.id ?? null;
      await this.markNeedsReview(payout, 'Provider accepted the request but returned no transfer');
      throw new ServiceUnavailableException(this.unconfirmedMessage);
    }
    try {
      await this.applyTransfer(payout, batch.id, transfer);
    } catch (err: any) {
      this.logger.error(
        `Payout ${payout.id}: transfer ${transfer.id} (batch ${batch.id}) was created but saving it failed: ${err?.message}`,
      );
      throw new ServiceUnavailableException(this.unconfirmedMessage);
    }
    return this.toView(payout);
  }

  // ---- internals -----------------------------------------------------------------------------

  private readonly unconfirmedMessage =
    'We could not confirm your payout with the payment provider. The amount is on hold while we check — please do not retry.';

  private async handleSubmitError(payout: OrganizerPayout, err: any): Promise<never> {
    const repo = this.dataSource.getRepository(OrganizerPayout);
    const providerStatus = err?.providerStatus;

    if (typeof providerStatus === 'number' && providerStatus < 500) {
      // PayMongo answered with a rejection: the transfer does not exist. Release the reservation.
      payout.status = OrganizerPayoutStatus.FAILED;
      payout.failureReason = String(err?.providerDetail ?? 'Rejected by the payment provider').slice(0, 255);
      payout.completedAt = new Date();
      await repo.save(payout);
      this.logger.warn(`Payout ${payout.id} rejected by PayMongo (${providerStatus}): ${payout.failureReason}`);
      throw new BadGatewayException('The payout was rejected by the payment provider');
    }

    // Timeout / unreachable / 5xx: it may or may not have gone through.
    this.logger.error(`Payout ${payout.id} outcome unknown: ${err?.message ?? err}`);
    await this.markNeedsReview(payout, 'Could not confirm the transfer with the payment provider');
    throw new ServiceUnavailableException(this.unconfirmedMessage);
  }

  private async markNeedsReview(payout: OrganizerPayout, reason: string) {
    payout.needsReview = true;
    payout.failureReason = reason.slice(0, 255);
    await this.dataSource.getRepository(OrganizerPayout).save(payout);
  }

  private pickTransfer(transfers: PaymongoTransfer[], payout: OrganizerPayout): PaymongoTransfer | undefined {
    return transfers.find((t) => t.referenceNumber === payout.referenceNumber) ?? transfers[0];
  }

  private async applyTransfer(payout: OrganizerPayout, batchId: string | null, transfer: PaymongoTransfer) {
    payout.paymongoBatchId = batchId ?? payout.paymongoBatchId;
    payout.paymongoTransferId = transfer.id ?? payout.paymongoTransferId;
    payout.status = mapTransferStatus(transfer.status);
    if (payout.status !== OrganizerPayoutStatus.PENDING) {
      payout.completedAt = new Date();
      payout.needsReview = false;
    }
    if (payout.status === OrganizerPayoutStatus.FAILED) {
      payout.failureReason = 'The transfer failed at the payment provider';
    }
    await this.dataSource.getRepository(OrganizerPayout).save(payout);
  }

  /** Asks PayMongo about a pending payout (throttled). Never throws: a hiccup must not break a read. */
  private async syncQuietly(payout: OrganizerPayout, opts: { force?: boolean } = {}): Promise<OrganizerPayout> {
    if (payout.status !== OrganizerPayoutStatus.PENDING || !payout.paymongoBatchId) return payout;

    const minGap = Number(this.config.get('PAYOUT_REFRESH_MIN_INTERVAL_SECONDS') ?? 8) * 1000;
    const last = this.lastCheck.get(payout.id) ?? 0;
    if (!opts.force && Date.now() - last < minGap) return payout;
    this.lastCheck.set(payout.id, Date.now());
    if (this.lastCheck.size > 5000) this.lastCheck.clear();

    try {
      const batch = await this.paymongo.getBatchTransfer(payout.paymongoBatchId);
      const transfer = this.pickTransfer(batch.transfers, payout);
      if (transfer) await this.applyTransfer(payout, batch.id, transfer);
    } catch (err: any) {
      this.logger.warn(`Could not refresh payout ${payout.id}: ${err?.message}`);
    }
    return payout;
  }

  private async orgIdFor(userId: string): Promise<string | null> {
    const org = await this.dataSource.getRepository(Organization).findOne({ where: { ownerUserId: userId } });
    return org?.id ?? null;
  }

  /** What the frontend may see: no PayMongo ids, no full account number. */
  toView(p: OrganizerPayout) {
    return {
      id: p.id,
      status: p.status,
      amountCentavos: p.amountCentavos,
      amount: centavosToPesos(p.amountCentavos),
      currency: p.currency,
      provider: p.provider,
      referenceNumber: p.referenceNumber,
      destination: {
        name: p.destinationName,
        bankCode: p.destinationBankCode,
        maskedAccountNumber: p.destinationLast4 ? `•••• •••• ${p.destinationLast4}` : null,
      },
      failureReason: p.failureReason,
      needsReview: !!p.needsReview,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    };
  }
}

/** PayMongo transfer status -> ours. Anything not final stays pending. */
function mapTransferStatus(status: string): OrganizerPayoutStatus {
  if (status === 'succeeded') return OrganizerPayoutStatus.SUCCEEDED;
  if (status === 'failed') return OrganizerPayoutStatus.FAILED;
  return OrganizerPayoutStatus.PENDING;
}
