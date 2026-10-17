import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type PaymentLogSource = 'api' | 'webhook' | 'reconcile' | 'expiry' | 'system';

/** Append-only audit trail: one row per payment state change (or notable non-change). */
@Entity('payment_status_logs')
export class PaymentStatusLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index()
  @Column({ type: 'bigint', name: 'payment_id' })
  paymentId: string;

  @Column({ type: 'varchar', name: 'from_status', length: 32, nullable: true })
  fromStatus: string | null;

  @Column({ type: 'varchar', name: 'to_status', length: 32 })
  toStatus: string;

  @Column({ type: 'varchar', length: 16 })
  source: PaymentLogSource;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
