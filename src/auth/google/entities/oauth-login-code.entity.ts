import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../../users/entities/user.entity';

/**
 * One-time hand-off between the API callback and the Nuxt app. The browser is redirected with a
 * random code (never with tokens in the URL); the app POSTs it to /auth/google/exchange and gets
 * the real tokens back. Only the SHA-256 of the code is stored; it lives 60 seconds and works once.
 */
@Entity('oauth_login_codes')
export class OauthLoginCode {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', name: 'code_hash', length: 64 })
  codeHash: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  /** Validated relative frontend path to land on afterwards (or NULL for the role's home). */
  @Column({ type: 'varchar', name: 'return_to', length: 255, nullable: true })
  returnTo: string | null;

  @Column({ type: 'datetime', name: 'expires_at' })
  expiresAt: Date;

  @Column({ type: 'datetime', name: 'consumed_at', nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
