import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Achievement } from './achievement.entity';

@Entity('runner_achievements')
@Unique(['userId', 'achievementId']) // prevents duplicate progress rows for the same achievement
export class RunnerAchievement {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'bigint', name: 'achievement_id' })
  achievementId: string;

  @Column({ type: 'decimal', name: 'progress_current', precision: 10, scale: 2, default: 0 })
  progressCurrent: string;

  @Column({ type: 'decimal', name: 'progress_target', precision: 10, scale: 2 })
  progressTarget: string;

  // Nullable until complete.
  @Column({ type: 'datetime', name: 'earned_at', nullable: true })
  earnedAt: Date;

  @ManyToOne(() => User, (user) => user.runnerAchievements, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Achievement, (achievement) => achievement.runnerAchievements, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'achievement_id' })
  achievement: Achievement;
}
