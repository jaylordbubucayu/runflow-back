import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { WebhookEventStatus } from '../../common/enums';

/**
 * Every verified PayMongo webhook delivery, keyed by PayMongo's event id (`evt_…`). The unique key
 * is what makes redelivery idempotent: a second delivery of the same event is recognised and
 * acknowledged without being applied twice. Only signature-verified requests are stored.
 */
@Entity('payment_webhook_events')
export class PaymentWebhookEvent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', name: 'provider_event_id', length: 100 })
  providerEventId: string;

  @Column({ type: 'varchar', name: 'event_type', length: 100 })
  eventType: string;

  @Column({ type: 'bigint', name: 'payment_id', nullable: true })
  paymentId: string | null;

  @Column({ type: 'enum', enum: WebhookEventStatus, default: WebhookEventStatus.RECEIVED })
  status: WebhookEventStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  detail: string | null;

  @Column({ type: 'json' })
  payload: Record<string, any>;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;

  @Column({ type: 'datetime', name: 'processed_at', nullable: true })
  processedAt: Date | null;
}