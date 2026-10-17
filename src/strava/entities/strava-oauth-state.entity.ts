import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Short-lived, single-use OAuth `state` record. Only the SHA-256 of the state is stored, so a
 * database leak can't be replayed. Bound to the user who started the flow; the callback is only
 * accepted from that same authenticated user (defeats "link my Strava to the victim's account"
 * CSRF as well as plain state forgery).
 */
@Entity('strava_oauth_states')
export class StravaOauthState {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'char', name: 'state_hash', length: 64 })
  stateHash: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  /** Validated relative frontend path, stored server-side — never read from the callback. */
  @Column({ type: 'varchar', name: 'return_to', length: 255 })
  returnTo: string;

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
