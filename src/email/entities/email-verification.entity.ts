import { User } from "src/users/entities/user.entity";
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

// email-verification.entity.ts
@Entity('email_verifications')
export class EmailVerification {
  @PrimaryGeneratedColumn() id: number;

  @Index('IDX_email_verifications_email')
  @Column({ length: 254 })
  email: string;

  @Column({ length: 64 }) codeHash: string;
  @Column({ type: 'datetime', precision: 6 }) expiresAt: Date;
  @Column({ default: 0 }) attempts: number;
  @Column({ type: 'datetime', precision: 6, nullable: true }) consumedAt: Date | null;

  // Set in code (not a DB default) so the resend cooldown doesn't drift if the DB and Node timezones differ.
  @Column({ type: 'datetime', precision: 6 }) createdAt: Date;
}