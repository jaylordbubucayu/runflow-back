import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PersonalBest } from './entities/personal-best.entity';
import { Achievement } from './entities/achievement.entity';
import { RunnerAchievement } from './entities/runner-achievement.entity';
import { Result } from '../results/entities/result.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { RunnerStatsService } from './runner-stats.service';
import { RunnerStatsController } from './runner-stats.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PersonalBest,
      Achievement,
      RunnerAchievement,
      Result,
      Registration,
    ]),
  ],
  controllers: [RunnerStatsController],
  providers: [RunnerStatsService],
  exports: [RunnerStatsService],
})
export class RunnerStatsModule {}
