import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { OrganizerPayoutStatus } from '../../common/enums';

/** BIGINT comes back from mysql2 as a string; centavo amounts are far below 2^53, so use number. */
const bigintToNumber = {
  to: (v?: number | null) => v,
  from: (v?: string | number | null) => (v === null || v === undefined ? null : Number(v)),
};

/**
 * One row per transfer sent to an organizer (PayMongo Transfer V2). A PENDING or SUCCEEDED row
 * counts against the organizer's available balance; a FAILED row releases it again.
 *
 * `needsReview` marks a payout whose submission to PayMongo could not be confirmed (timeout, 5xx):
 * the transfer may or may not exist, so the amount stays reserved and nothing is retried
 * automatically — that is what prevents paying the same money out twice.
 */
@Entity('organizer_payouts')
@Index('IDX_organizer_payouts_org_status', ['organizationId', 'status'])
export class OrganizerPayout {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'organization_id', nullable: true })
  organizationId: string | null;

  @Column({ type: 'bigint', name: 'payout_account_id', nullable: true })
  payoutAccountId: string | null;

  @Column({ type: 'bigint', name: 'amount_centavos', transformer: bigintToNumber })
  amountCentavos: number;

  @Column({ type: 'varchar', length: 3, default: 'PHP' })
  currency: string;

  @Column({ type: 'enum', enum: OrganizerPayoutStatus, default: OrganizerPayoutStatus.PENDING })
  status: OrganizerPayoutStatus;

  /** instapay | pesonet | paymongo */
  @Column({ type: 'varchar', length: 32 })
  provider: string;

  /** Our idempotency key, sent to PayMongo as the transfer's reference_number. */
  @Index('UQ_organizer_payouts_reference', { unique: true })
  @Column({ type: 'varchar', name: 'reference_number', length: 64 })
  referenceNumber: string;

  @Column({ type: 'varchar', name: 'destination_bank_code', length: 32, nullable: true })
  destinationBankCode: string | null;

  @Column({ type: 'varchar', name: 'destination_last4', length: 4, nullable: true })
  destinationLast4: string | null;

  @Column({ type: 'varchar', name: 'destination_name', length: 255, nullable: true })
  destinationName: string | null;

  @Column({ type: 'varchar', name: 'paymongo_account_id', length: 64, nullable: true })
  paymongoAccountId: string | null;

  @Column({ type: 'varchar', name: 'paymongo_batch_id', length: 64, nullable: true })
  paymongoBatchId: string | null;

  @Column({ type: 'varchar', name: 'paymongo_transfer_id', length: 64, nullable: true })
  paymongoTransferId: string | null;

  @Column({ type: 'varchar', name: 'failure_reason', length: 255, nullable: true })
  failureReason: string | null;

  @Column({ type: 'tinyint', name: 'needs_review', default: 0 })
  needsReview: boolean;

  @Column({ type: 'bigint', name: 'requested_by_user_id', nullable: true })
  requestedByUserId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ type: 'datetime', name: 'completed_at', nullable: true })
  completedAt: Date | null;
}
