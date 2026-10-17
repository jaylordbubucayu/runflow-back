import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Registration } from '../../registrations/entities/registration.entity';
import { PersonalBest } from '../../runner-stats/entities/personal-best.entity';

@Entity('results')
export class Result {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint', name: 'registration_id', unique: true })
  registrationId: string;

  @Column({ type: 'time', name: 'official_time', nullable: true })
  officialTime: string;

  @Column({ type: 'time', name: 'gun_time', nullable: true })
  gunTime: string;

  @Column({ type: 'time', name: 'chip_time', nullable: true })
  chipTime: string;

  @Column({ type: 'varchar', name: 'pace_per_km', nullable: true })
  pacePerKm: string;

  @Column({ type: 'decimal', name: 'distance_km', precision: 6, scale: 2 })
  distanceKm: string;

  @Column({ type: 'int', name: 'overall_rank', nullable: true })
  overallRank: number;

  @Column({ type: 'int', name: 'category_rank', nullable: true })
  categoryRank: number;

  @Column({ type: 'int', name: 'age_group_rank', nullable: true })
  ageGroupRank: number;

  @Column({ type: 'boolean', name: 'is_verified', default: false })
  isVerified: boolean;

  @Column({ type: 'datetime', name: 'published_at', nullable: true })
  publishedAt: Date;

  @OneToOne(() => Registration, (registration) => registration.result, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'registration_id' })
  registration: Registration;

  @OneToMany(() => PersonalBest, (pb) => pb.result)
  personalBests: PersonalBest[];
}
