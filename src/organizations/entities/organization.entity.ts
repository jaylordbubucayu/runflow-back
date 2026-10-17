import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { OrganizationStatus } from '../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Event } from '../../events/entities/event.entity';
import { PlatformFeeConfig } from '../../payments/entities/platform-fee-config.entity';

@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'owner_user_id' })
  ownerUserId: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', name: 'logo_url', nullable: true })
  logoUrl: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: true })
  website: string;

  @Column({ type: 'json', name: 'social_links', nullable: true })
  socialLinks: Record<string, string>;

  @Column({ type: 'varchar', name: 'contact_email', nullable: true })
  contactEmail: string;

  @Column({ type: 'varchar', name: 'contact_number', nullable: true })
  contactNumber: string;

  @Column({
    type: 'enum',
    enum: OrganizationStatus,
    default: OrganizationStatus.PENDING,
  })
  status: OrganizationStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToOne(() => User, (user) => user.organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'owner_user_id' })
  owner: User;

  @OneToMany(() => Event, (event) => event.organization)
  events: Event[];

  @OneToOne(() => PlatformFeeConfig, (config) => config.organization)
  feeConfigOverride: PlatformFeeConfig;
}
