import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('password_reset_challenges')
@Index('idx_prc_user_created', ['userId', 'createdAt'])
@Index('idx_prc_reset_token_hash', ['resetTokenHash'])
export class PasswordResetChallenge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** users.id is BIGINT; TypeORM returns bigint columns as strings. */
  @Column({ name: 'user_id', type: 'bigint' })
  userId: string;

  @Column({ name: 'otp_hash', type: 'char', length: 64 })
  otpHash: string;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'verified_at', type: 'datetime', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'reset_token_hash', type: 'char', length: 64, nullable: true })
  resetTokenHash: string | null;

  @Column({ name: 'reset_token_expires_at', type: 'datetime', nullable: true })
  resetTokenExpiresAt: Date | null;

  @Column({ name: 'consumed_at', type: 'datetime', nullable: true })
  consumedAt: Date | null;

  @Column({ name: 'created_at', type: 'datetime' })
  createdAt: Date;
}