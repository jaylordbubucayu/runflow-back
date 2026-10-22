import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Organization } from '../../organizations/entities/organization.entity';
import { PayoutAccountType, PayoutAccountStatus } from '../../common/enums';

/**
 * One payout account per organization (enforced by the unique index on organization_id — see the
 * migration). The full account number is never stored in plaintext: `accountNumberEncrypted`
 * holds an AES-256-GCM ciphertext (see payout-crypto.ts), and `accountNumberLast4` holds only the
 * last 4 digits in plaintext, which is all the API ever returns (as `maskedAccountNumber`).
 * The full number is decrypted in exactly one place: OrganizerPayoutsService, at the moment a
 * PayMongo transfer is submitted.
 *
 * `paymongoAccountId` is the `org_…` id of the PayMongo linked (child) account created for this
 * organizer via POST /v2/accounts; payouts are refused until it is set.
 */
@Entity('organizer_payout_accounts')
export class OrganizerPayoutAccount {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'organization_id' })
  organizationId: string;

  @Column({ type: 'enum', enum: PayoutAccountType })
  type: PayoutAccountType;

  @Column({ type: 'varchar' })
  provider: string;

  @Column({ type: 'varchar', name: 'account_holder_name' })
  accountHolderName: string;

  @Column({ type: 'text', name: 'account_number_encrypted' })
  accountNumberEncrypted: string;

  @Column({ type: 'varchar', name: 'account_number_last4', length: 4 })
  accountNumberLast4: string;

  /** BIC of the destination bank / e-wallet (from PayMongo's receiving institutions). Needed to send a transfer. */
  @Column({ type: 'varchar', name: 'bank_code', length: 32, nullable: true })
  bankCode: string | null;

  @Column({
    type: 'enum',
    enum: PayoutAccountStatus,
    default: PayoutAccountStatus.PENDING,
  })
  status: PayoutAccountStatus;

  /** PayMongo linked-account id (`org_…`) from POST /v2/accounts. NULL until connected. */
  @Column({ type: 'varchar', name: 'paymongo_account_id', length: 64, nullable: true })
  paymongoAccountId: string | null;

  /** pending | under_review | activated | declined — as last reported by PayMongo. */
  @Column({ type: 'varchar', name: 'paymongo_activation_status', length: 32, nullable: true })
  paymongoActivationStatus: string | null;

  @Column({ type: 'datetime', name: 'paymongo_connected_at', nullable: true })
  paymongoConnectedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}