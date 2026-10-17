import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
} from 'typeorm';
import { AchievementCriteriaType } from '../../common/enums';
import { RunnerAchievement } from './runner-achievement.entity';

@Entity('achievements')
export class Achievement {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', unique: true })
  code: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'varchar', nullable: true })
  icon: string;

  @Column({ type: 'enum', enum: AchievementCriteriaType, name: 'criteria_type' })
  criteriaType: AchievementCriteriaType;

  @Column({ type: 'decimal', name: 'criteria_value', precision: 10, scale: 2 })
  criteriaValue: string;

  @OneToMany(() => RunnerAchievement, (ra) => ra.achievement)
  runnerAchievements: RunnerAchievement[];
}
