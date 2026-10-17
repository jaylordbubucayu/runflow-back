import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * One row per RunFlow user (unique user_id). Tokens are AES-256-GCM ciphertext (see
 * StravaCryptoService) and are NULLed on disconnect/revocation; the row is kept so activity
 * history stays attached. strava_athlete_id is NULLed on disconnect too, so a Strava account is
 * "reserved" by at most one *currently connected* RunFlow account (unique index).
 */
@Entity('strava_connections')
export class StravaConnection {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'bigint', name: 'strava_athlete_id', nullable: true })
  stravaAthleteId: string | null;

  @Column({ type: 'varchar', name: 'athlete_display_name', length: 120, nullable: true })
  athleteDisplayName: string | null;

  @Column({ type: 'text', name: 'access_token_encrypted', nullable: true })
  accessTokenEncrypted: string | null;

  @Column({ type: 'text', name: 'refresh_token_encrypted', nullable: true })
  refreshTokenEncrypted: string | null;

  @Column({ type: 'datetime', name: 'expires_at', nullable: true })
  expiresAt: Date | null;

  /** Space-separated scopes Strava says were actually granted. */
  @Column({ type: 'varchar', length: 255, default: '' })
  scopes: string;

  @Column({ type: 'boolean', name: 'is_connected', default: false })
  isConnected: boolean;

  /** 'user' | 'revoked' | 'insufficient_scope' — why is_connected went false. */
  @Column({ type: 'varchar', name: 'disconnect_reason', length: 32, nullable: true })
  disconnectReason: string | null;

  @Column({ type: 'datetime', name: 'disconnected_at', nullable: true })
  disconnectedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
