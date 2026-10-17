import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  OneToMany,
} from 'typeorm';
import { UserRole } from '../../common/enums';
import { RunnerProfile } from './runner-profile.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { Registration } from '../../registrations/entities/registration.entity';
import { CheckIn } from '../../checkin/entities/check-in.entity';
import { PersonalBest } from '../../runner-stats/entities/personal-best.entity';
import { RunnerAchievement } from '../../runner-stats/entities/runner-achievement.entity';
import { Notification } from '../../notifications/entities/notification.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', unique: true })
  email: string;

  @Column({ type: 'varchar', name: 'password_hash', nullable: true, select: false })
  passwordHash: string;

  @Column({ type: 'varchar', nullable: true })
  phone: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.RUNNER })
  role: UserRole;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @Column({ type: 'varchar', name: 'google_id', nullable: true })
  googleId: string;

  // Auto-created by guest checkout (see RegistrationsService.findOrCreateGuestUser), with an
  // unusable password. Distinguishes "a real account happens to exist" from "this is just a
  // bucket for someone's guest registrations" — if a guest checkout's email already belongs to a
  // user with isGuest=false, we refuse rather than silently attaching to a stranger's account.
  @Column({ type: 'boolean', name: 'is_guest', default: false })
  isGuest: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToOne(() => RunnerProfile, (profile) => profile.user)
  runnerProfile: RunnerProfile;

  @OneToOne(() => Organization, (org) => org.owner)
  organization: Organization;

  @OneToMany(() => Registration, (registration) => registration.runner)
  registrations: Registration[];

  @OneToMany(() => CheckIn, (checkIn) => checkIn.checkedInByUser)
  checkInsPerformed: CheckIn[];

  @OneToMany(() => PersonalBest, (pb) => pb.user)
  personalBests: PersonalBest[];

  @OneToMany(() => RunnerAchievement, (ra) => ra.user)
  runnerAchievements: RunnerAchievement[];

  @OneToMany(() => Notification, (notification) => notification.user)
  notifications: Notification[];
  
}