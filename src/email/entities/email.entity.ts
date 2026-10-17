import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum EmailStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  DRY_RUN = 'dry_run',
}

@Entity({ name: 'email_logs' })
@Index('idx_email_logs_status_created', ['status', 'createdAt'])
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_email_logs_message_id')
  @Column({ name: 'message_id', type: 'varchar', length: 255, nullable: true })
  messageId!: string | null;

  @Column({ type: 'varchar', length: 20, default: EmailStatus.PENDING })
  status!: EmailStatus;

  @Column({ type: 'varchar', length: 50 })
  provider!: string;

  @Column({ name: 'from_address', type: 'varchar', length: 320 })
  from!: string;

  @Column({ name: 'to_addresses', type: 'json' })
  to!: string[];

  @Column({ name: 'cc_addresses', type: 'json', nullable: true })
  cc!: string[] | null;

  @Column({ name: 'bcc_addresses', type: 'json', nullable: true })
  bcc!: string[] | null;

  @Column({ type: 'varchar', length: 200 })
  subject!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  template!: string | null;

  /** SHA-256 of the body: lets you prove what was sent without storing it. */
  @Column({ name: 'body_hash', type: 'char', length: 64, nullable: true })
  bodyHash!: string | null;

  @Column({ type: 'mediumtext', nullable: true })
  body!: string | null;

  @Column({ name: 'attachment_count', type: 'int', default: 0 })
  attachmentCount!: number;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'json', nullable: true })
  accepted!: string[] | null;

  @Column({ type: 'json', nullable: true })
  rejected!: string[] | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;

  @Column({ type: 'json', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;

  @Column({ name: 'sent_at', type: 'datetime', precision: 6, nullable: true })
  sentAt!: Date | null;
}