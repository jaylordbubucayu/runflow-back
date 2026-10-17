import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Registration } from '../../registrations/entities/registration.entity';
import { User } from '../../users/entities/user.entity';

@Entity('check_ins')
export class CheckIn {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  // Unique -> guards against duplicate check-in for the same registration.
  @Column({ type: 'bigint', name: 'registration_id', unique: true })
  registrationId: string;

  @Column({ type: 'bigint', name: 'checked_in_by_user_id' })
  checkedInByUserId: string;

  @Column({ type: 'datetime', name: 'checked_in_at' })
  checkedInAt: Date;

  @Column({ type: 'varchar', name: 'device_info', nullable: true })
  deviceInfo: string;

  @OneToOne(() => Registration, (registration) => registration.checkIn, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'registration_id' })
  registration: Registration;

  @ManyToOne(() => User, (user) => user.checkInsPerformed, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'checked_in_by_user_id' })
  checkedInByUser: User;
}
