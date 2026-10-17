import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Result } from '../../results/entities/result.entity';

@Entity('personal_bests')
@Unique(['userId', 'distanceKm'])
export class PersonalBest {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'user_id' })
  userId: string;

  @Column({ type: 'decimal', name: 'distance_km', precision: 6, scale: 2 })
  distanceKm: string;

  @Column({ type: 'time', name: 'best_time' })
  bestTime: string;

  @Column({ type: 'bigint', name: 'result_id' })
  resultId: string;

  @Column({ type: 'datetime', name: 'achieved_at' })
  achievedAt: Date;

  @ManyToOne(() => User, (user) => user.personalBests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Result, (result) => result.personalBests, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'result_id' })
  result: Result;
}
