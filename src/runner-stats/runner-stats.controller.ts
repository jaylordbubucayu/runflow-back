import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RunnerStatsService } from './runner-stats.service';
import { User } from '../users/entities/user.entity';

@UseGuards(JwtAuthGuard)
@Controller('runner')
export class RunnerStatsController {
  constructor(private readonly runnerStatsService: RunnerStatsService) {}

  @Get('stats')
  getStats(@CurrentUser() user: User) {
    return this.runnerStatsService.getDashboardStats(user.id);
  }

  @Get('stats/distance')
  getDistanceBreakdown(
    @CurrentUser() user: User,
    @Query('range') range: 'week' | 'month' | 'year' | 'all' = 'month',
  ) {
    return this.runnerStatsService.getDistanceBreakdown(user.id, range);
  }

  @Get('achievements')
  getAchievements(@CurrentUser() user: User) {
    return this.runnerStatsService.getAchievements(user.id);
  }

  @Get('personal-bests')
  getPersonalBests(@CurrentUser() user: User) {
    return this.runnerStatsService.getPersonalBests(user.id);
  }
}
