import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Registration } from '../../registrations/entities/registration.entity';
import { StravaConnection } from './strava-connection.entity';
import { StravaActivityKind, StravaActivityStatus } from '../strava.constants';

/**
 * Local record of one "publish to Strava" attempt for a registration. event_id is intentionally
 * absent: it is derivable from registration_id (registrations.event_id).
 *
 * Duplicate prevention is enforced by the database, not just by code:
 *  - (user_id, client_request_id) unique      -> a replayed/double-clicked request is the same row
 *  - active_registration_key unique           -> one live activity per registration
 *  - active_file_key unique                   -> the same file can't be live twice for a user
 *  - strava_activity_id unique                -> one Strava activity maps to one record
 * The two active_* keys are NULL once a row is `failed`, and MySQL unique indexes allow many
 * NULLs, so a failed attempt never blocks a corrected retry.
 */
@Entity('strava_activities')
export class StravaActivity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'bigint', name: 'registration_id' })
  registrationId: string;

  @Column({ type: 'bigint', name: 'strava_connection_id' })
  stravaConnectionId: string;

  @Column({ type: 'enum', enum: StravaActivityKind })
  kind: StravaActivityKind;

  @Column({ type: 'varchar', name: 'client_request_id', length: 64 })
  clientRequestId: string;

  @Column({ type: 'bigint', name: 'strava_activity_id', nullable: true })
  stravaActivityId: string | null;

  @Column({ type: 'bigint', name: 'strava_upload_id', nullable: true })
  stravaUploadId: string | null;

  @Column({ type: 'varchar', name: 'activity_type', length: 32, nullable: true })
  activityType: string | null;

  @Column({ type: 'varchar', name: 'activity_name', length: 255, nullable: true })
  activityName: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'decimal', name: 'distance_meters', precision: 10, scale: 2, nullable: true })
  distanceMeters: string | null;

  @Column({ type: 'int', name: 'moving_time_seconds', nullable: true })
  movingTimeSeconds: number | null;

  @Column({ type: 'int', name: 'elapsed_time_seconds', nullable: true })
  elapsedTimeSeconds: number | null;

  /** Local wall-clock start, as the runner entered it / as Strava reports start_date_local. */
  @Column({ type: 'datetime', name: 'start_date', nullable: true })
  startDate: Date | null;

  @Column({ type: 'enum', enum: StravaActivityStatus, default: StravaActivityStatus.PENDING })
  status: StravaActivityStatus;

  @Column({ type: 'varchar', name: 'error_code', length: 64, nullable: true })
  errorCode: string | null;

  /** Safe, user-facing text only. Never contains tokens or raw upstream bodies. */
  @Column({ type: 'varchar', name: 'error_message', length: 255, nullable: true })
  errorMessage: string | null;

  @Column({ type: 'boolean', default: false })
  retryable: boolean;

  @Column({ type: 'char', name: 'file_sha256', length: 64, nullable: true })
  fileSha256: string | null;

  @Column({ type: 'bigint', name: 'active_registration_key', nullable: true })
  activeRegistrationKey: string | null;

  @Column({ type: 'varchar', name: 'active_file_key', length: 100, nullable: true })
  activeFileKey: string | null;

  @Column({ type: 'int', name: 'poll_attempts', default: 0 })
  pollAttempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Registration, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'registration_id' })
  registration: Registration;

  @ManyToOne(() => StravaConnection, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'strava_connection_id' })
  connection: StravaConnection;
}
