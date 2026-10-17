import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PersonalBest } from './entities/personal-best.entity';
import { Achievement } from './entities/achievement.entity';
import { RunnerAchievement } from './entities/runner-achievement.entity';
import { Result } from '../results/entities/result.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { RegistrationStatus, AchievementCriteriaType } from '../common/enums';

/**
 * Read-derived module (§4.6): everything here is recomputed from
 * Registration + Result. Nothing here is a source of truth, so it can
 * always be dropped and rebuilt if a bad import needs correcting.
 */
@Injectable()
export class RunnerStatsService {
  constructor(
    @InjectRepository(PersonalBest)
    private readonly personalBestsRepo: Repository<PersonalBest>,
    @InjectRepository(Achievement)
    private readonly achievementsRepo: Repository<Achievement>,
    @InjectRepository(RunnerAchievement)
    private readonly runnerAchievementsRepo: Repository<RunnerAchievement>,
    @InjectRepository(Result) private readonly resultsRepo: Repository<Result>,
    @InjectRepository(Registration)
    private readonly registrationsRepo: Repository<Registration>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('result.published')
  async recomputeAfterResult(payload: { userId: string; resultId: string }) {
    await this.updatePersonalBest(payload.userId, payload.resultId);
    await this.updateAchievementProgress(payload.userId);
  }

  private async updatePersonalBest(userId: string, resultId: string) {
    const result = await this.resultsRepo.findOne({ where: { id: resultId } });
    if (!result || !result.officialTime) return;

    const existing = await this.personalBestsRepo.findOne({
      where: { userId, distanceKm: result.distanceKm },
    });

    const isBetter =
      !existing || result.officialTime < existing.bestTime;

    if (isBetter) {
      const pb = this.personalBestsRepo.create({
        ...existing,
        userId,
        distanceKm: result.distanceKm,
        bestTime: result.officialTime,
        resultId,
        achievedAt: new Date(),
      });
      await this.personalBestsRepo.save(pb);
    }
  }

  private async updateAchievementProgress(userId: string) {
    const achievements = await this.achievementsRepo.find();
    const totals = await this.getDashboardStats(userId);

    for (const achievement of achievements) {
      let current = 0;
      switch (achievement.criteriaType) {
        case AchievementCriteriaType.DISTANCE_TOTAL:
          current = totals.totalDistance;
          break;
        case AchievementCriteriaType.EVENT_COUNT:
        case AchievementCriteriaType.FIRST_RUN:
          current = totals.totalRuns;
          break;
        default:
          // podium / early_run / pb need extra context per result;
          // left as a hook for a more detailed rule per achievement.
          continue;
      }

      let progress = await this.runnerAchievementsRepo.findOne({
        where: { userId, achievementId: achievement.id },
      });
      const target = Number(achievement.criteriaValue);

      progress = this.runnerAchievementsRepo.create({
        ...progress,
        userId,
        achievementId: achievement.id,
        progressCurrent: String(current),
        progressTarget: String(target),
        earnedAt:
          current >= target ? (progress?.earnedAt ?? new Date()) : progress?.earnedAt,
      });
      const saved = await this.runnerAchievementsRepo.save(progress);

      if (saved.earnedAt && !progress?.earnedAt) {
        this.eventEmitter.emit('achievement.earned', {
          userId,
          achievementId: achievement.id,
        });
      }
    }
  }

  async getDashboardStats(userId: string) {
    const raw = await this.registrationsRepo
      .createQueryBuilder('registration')
      .innerJoin('registration.result', 'result')
      .select('COUNT(result.id)', 'totalRuns')
      .addSelect('COALESCE(SUM(result.distanceKm), 0)', 'totalDistance')
      .where('registration.runnerUserId = :userId', { userId })
      .andWhere('registration.status = :status', {
        status: RegistrationStatus.COMPLETED,
      })
      .getRawOne();

    const eventsJoined = await this.registrationsRepo.count({
      where: { runnerUserId: userId },
    });

    return {
      totalRuns: Number(raw.totalRuns ?? 0),
      totalDistance: Number(raw.totalDistance ?? 0),
      eventsJoined,
    };
  }

  async getDistanceBreakdown(
    userId: string,
    range: 'week' | 'month' | 'year' | 'all',
  ) {
    const qb = this.registrationsRepo
      .createQueryBuilder('registration')
      .innerJoin('registration.result', 'result')
      .select('result.publishedAt', 'date')
      .addSelect('result.distanceKm', 'distanceKm')
      .where('registration.runnerUserId = :userId', { userId });

    if (range !== 'all') {
      const since = new Date();
      if (range === 'week') since.setDate(since.getDate() - 7);
      if (range === 'month') since.setMonth(since.getMonth() - 1);
      if (range === 'year') since.setFullYear(since.getFullYear() - 1);
      qb.andWhere('result.publishedAt >= :since', { since });
    }

    return qb.orderBy('result.publishedAt', 'ASC').getRawMany();
  }

  async getAchievements(userId: string) {
    return this.runnerAchievementsRepo.find({
      where: { userId },
      relations: ['achievement'],
    });
  }

  async getPersonalBests(userId: string) {
    return this.personalBestsRepo.find({
      where: { userId },
      order: { distanceKm: 'ASC' },
    });
  }
}
