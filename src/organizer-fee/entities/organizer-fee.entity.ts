import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * The platform fee an ORGANIZER pays to publish an event. Deliberately a separate table from
 * `platform_fee_configs`, which is the per-registration surcharge charged to RUNNERS on top of
 * the entry fee — different payer, different base, must never be edited by the same switch.
 *
 * Managed by admins through PUT /api/admin/organizer-event-fee. If no active row exists, no
 * organizer fee is required (publishing behaves exactly as it did before this feature).
 */
@Entity('organizer_fee_configs')
export class OrganizerFeeConfig {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({
    type: 'bigint',
    name: 'amount_centavos',
    transformer: { to: (v?: number) => v, from: (v: string | number) => Number(v) },
  })
  amountCentavos: number;

  @Column({ type: 'varchar', length: 3, default: 'PHP' })
  currency: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({ type: 'datetime', name: 'effective_from', default: () => 'CURRENT_TIMESTAMP' })
  effectiveFrom: Date;

  @Column({ type: 'bigint', name: 'created_by_user_id', nullable: true })
  createdByUserId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}