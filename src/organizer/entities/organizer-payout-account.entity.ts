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
 * holds an AES-256-GCM ciphertext (see PayoutEncryption in organizer.service.ts), and
 * `accountNumberLast4` holds only the last 4 digits in plaintext, which is all the API ever
 * returns (as `maskedAccountNumber`). Nothing in this codebase ever decrypts the full number back
 * out — that only becomes necessary once real payouts are actually sent, which is out of scope
 * for now (this project's payment provider integration is itself still a stub).
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

  @Column({
    type: 'enum',
    enum: PayoutAccountStatus,
    default: PayoutAccountStatus.PENDING,
  })
  status: PayoutAccountStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
