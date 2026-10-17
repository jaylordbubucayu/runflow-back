import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { FeeType } from '../../common/enums';
import { Organization } from '../../organizations/entities/organization.entity';

@Entity('platform_fee_configs')
export class PlatformFeeConfig {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  // Nullable = global default fee config.
  @Column({ type: 'bigint', name: 'organization_id', nullable: true })
  organizationId: string;

  @Column({ type: 'enum', enum: FeeType, name: 'fee_type' })
  feeType: FeeType;

  @Column({ type: 'decimal', name: 'fixed_amount', precision: 10, scale: 2, nullable: true })
  fixedAmount: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  percentage: string;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({ type: 'datetime', name: 'effective_from' })
  effectiveFrom: Date;

  @OneToOne(() => Organization, (org) => org.feeConfigOverride, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;
}
