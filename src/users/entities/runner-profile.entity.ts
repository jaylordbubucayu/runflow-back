import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Gender } from '../../common/enums';
import { User } from './user.entity';

@Entity('runner_profiles')
export class RunnerProfile {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', name: 'first_name' })
  firstName: string;

  @Column({ type: 'varchar', name: 'last_name' })
  lastName: string;

  @Column({ type: 'date', nullable: true })
  birthday: string;

  @Column({ type: 'enum', enum: Gender, nullable: true })
  gender: Gender;

  @Column({ type: 'varchar', name: 'avatar_url', nullable: true })
  avatarUrl: string;

  @Column({ type: 'varchar', name: 'shirt_size_default', nullable: true })
  shirtSizeDefault: string;

  @Column({ type: 'date', name: 'runner_since', nullable: true })
  runnerSince: string;

  @OneToOne(() => User, (user) => user.runnerProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
