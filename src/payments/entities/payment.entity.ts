import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '../../common/enums';
import { Registration } from '../../registrations/entities/registration.entity';

/** BIGINT comes back from mysql2 as a string; centavo amounts are far below 2^53, so use number. */
const bigintToNumber = {
  to: (v?: number | null) => v,
  from: (v?: string | number | null) => (v === null || v === undefined ? null : Number(v)),
};

/**
 * One row per PAYMENT ATTEMPT (a PayMongo Payment Link), for both payment purposes:
 *
 *   - RUNNER_REGISTRATION: `registrationId` (single) or registrations.payment_id (guest group).
 *   - ORGANIZER_EVENT_CREATION: `eventId` + `organizationId` + `ownerUserId`; registrationId is NULL.
 *
 * A retry creates a NEW row and supersedes the old one (CANCELLED/EXPIRED), so the table is also
 * the audit trail of attempts. Two partial-unique guards (generated column, see the migration)
 * make it impossible to have two PAID rows for the same registration or the same event fee.
 */
@Entity('payments')
@Index('IDX_payments_purpose_status', ['purpose', 'status'])
@Index('IDX_payments_event', ['eventId'])
@Index('IDX_payments_owner', ['ownerUserId'])
export class Payment {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({
    type: 'enum',
    enum: PaymentPurpose,
    default: PaymentPurpose.RUNNER_REGISTRATION,
  })
  purpose: PaymentPurpose;

  // Nullable: a group payment (multi-participant guest checkout) covers several registrations at
  // once, so it has no single one to point at — those registrations instead point back at this
  // payment via registrations.payment_id. Also NULL for organizer platform-fee payments.
  @Column({ type: 'bigint', name: 'registration_id', nullable: true })
  registrationId: string | null;

  // The event this payment is about: the runner's event, or the event whose platform fee this is.
  @Column({ type: 'bigint', name: 'event_id', nullable: true })
  eventId: string | null;

  // The organization that owns the event (organizer fee) — handy for reporting.
  @Column({ type: 'bigint', name: 'organization_id', nullable: true })
  organizationId: string | null;

  // The user who initiated the payment (runner or organizer). NULL for guest-group payments
  // (the shadow guest user is reachable through the registrations).
  @Column({ type: 'bigint', name: 'owner_user_id', nullable: true })
  ownerUserId: string | null;

  @Column({ type: 'varchar', default: PaymentProvider.PAYMONGO })
  provider: PaymentProvider;

  /** PayMongo's payment id (`pay_…`), recorded when the paid webhook/reconciliation lands. */
  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'provider_payment_id', nullable: true })
  providerPaymentId: string;

  /** PayMongo Payment Link id (`link_…`). Kept under the original column name. */
  @Index('IDX_payments_provider_checkout')
  @Column({ type: 'varchar', name: 'provider_checkout_id', nullable: true })
  providerCheckoutId: string;

  /** PayMongo-generated short reference (the code in the pm.link URL). Not settable by us. */
  @Column({ type: 'varchar', name: 'provider_reference_number', nullable: true })
  providerReferenceNumber: string | null;

  @Column({ type: 'varchar', name: 'checkout_url', length: 512, nullable: true })
  checkoutUrl: string | null;

  /** The amount actually charged, in centavos — the figure the webhook amount is checked against. */
  @Column({ type: 'bigint', name: 'amount_centavos', nullable: true, transformer: bigintToNumber })
  amountCentavos: number | null;

  @Column({ type: 'varchar', length: 3, default: 'PHP' })
  currency: string;

  // Display columns (pesos). For organizer fees: registration_fee = 0, platform_fee = total = fee.
  @Column({ type: 'decimal', name: 'registration_fee', precision: 10, scale: 2 })
  registrationFee: string;

  @Column({ type: 'decimal', name: 'platform_fee', precision: 10, scale: 2 })
  platformFee: string;

  @Column({ type: 'decimal', name: 'total_amount', precision: 10, scale: 2 })
  totalAmount: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: 'varchar', name: 'payment_method', length: 64, nullable: true })
  paymentMethod: string | null;

  /** Our own link timeout. PayMongo Payment Links do not expire on their own. */
  @Column({ type: 'datetime', name: 'expires_at', nullable: true })
  expiresAt: Date | null;

  /** Set when money arrived that the system could not apply cleanly (duplicate, mismatch, late). */
  @Column({ type: 'tinyint', name: 'needs_reconciliation', default: 0 })
  needsReconciliation: boolean;

  @Column({ type: 'varchar', name: 'reconciliation_note', length: 255, nullable: true })
  reconciliationNote: string | null;

  /** 'reg:<id>' / 'org:<eventId>' while PAID, NULL otherwise. UNIQUE: one paid row per thing. */
  @Column({ type: 'varchar', name: 'paid_guard_key', length: 80, nullable: true, select: false })
  paidGuardKey: string | null;

  @Column({ type: 'json', name: 'webhook_payload', nullable: true })
  webhookPayload: Record<string, any>;

  @Column({ type: 'datetime', name: 'paid_at', nullable: true })
  paidAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => Registration, (registration) => registration.payments, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'registration_id' })
  registration: Registration | null;
}