import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { parse } from 'csv-parse/sync';
import { Result } from './entities/result.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { RunnerProfile } from '../users/entities/runner-profile.entity';
import { RegistrationStatus } from '../common/enums';
import { ImportResultRowDto } from './dto/import-result-row.dto';
import { SetPlaceDto, SetPlaceByBibRowDto } from './dto/set-place.dto';

// ---------------------------------------------------------------------------
// Timing-file helpers (move to utils/timing.util.ts if you prefer)
// ---------------------------------------------------------------------------
const HEADER_ALIASES = {
  bib: ['bib', 'bibno', 'bibnumber', 'bib#'],
  chipTime: ['chiptime', 'nettime', 'net', 'chip'],
  gunTime: ['guntime', 'clocktime', 'gross', 'gun'],
  status: ['status', 'state'],
} as const;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]/g, '');

function pick(
  row: Record<string, string>,
  key: keyof typeof HEADER_ALIASES,
): string | undefined {
  for (const [header, value] of Object.entries(row)) {
    if ((HEADER_ALIASES[key] as readonly string[]).includes(norm(header))) {
      return value?.trim() || undefined;
    }
  }
  return undefined;
}

// "1:23:45.67" | "23:45" | "00:41:22" -> seconds
function toSeconds(t?: string | null): number | null {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  if (parts.some((p) => isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatTime(sec: number): string {
  const total = Math.round(sec * 10) / 10; // avoid "60.0" seconds edge case
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s
    .toFixed(1)
    .padStart(4, '0')}`;
}

function formatPace(sec: number, km: number): string {
  const p = sec / km;
  let m = Math.floor(p / 60);
  let s = Math.round(p % 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

@Injectable()
export class ResultsService {
  constructor(
    @InjectRepository(Result) private readonly resultsRepo: Repository<Result>,
    @InjectRepository(Registration)
    private readonly registrationsRepo: Repository<Registration>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  async importResults(eventId: string, rows: ImportResultRowDto[]) {
    const saved: Result[] = [];

    for (const row of rows) {
      const registration = await this.registrationsRepo.findOne({
        where: { id: row.registrationId, eventId },
      });
      if (!registration) continue; // skip rows that don't belong to this event

      let result = await this.resultsRepo.findOne({
        where: { registrationId: row.registrationId },
      });
      result = this.resultsRepo.create({
        ...result,
        registrationId: row.registrationId,
        officialTime: row.officialTime,
        gunTime: row.gunTime,
        chipTime: row.chipTime,
        pacePerKm: row.pacePerKm,
        distanceKm: row.distanceKm as any,
        overallRank: row.overallRank,
        categoryRank: row.categoryRank,
        ageGroupRank: row.ageGroupRank,
        publishedAt: new Date(),
      });
      const savedResult = await this.resultsRepo.save(result);
      saved.push(savedResult);

      registration.status = RegistrationStatus.COMPLETED;
      await this.registrationsRepo.save(registration);

      // Consumed by RunnerStatsModule, CertificatesModule, NotificationsModule.
      this.eventEmitter.emit('result.published', {
        registrationId: registration.id,
        userId: registration.runnerUserId,
        resultId: savedResult.id,
      });
    }

    return saved;
  }

  /**
   * Import results from a timing-system CSV (kept in memory, never stored).
   * Matches rows to registrations by bib number, then recalculates ranks.
   * Use { dryRun: true } to preview without saving anything.
   */
  async importFromTimingFile(
    eventId: string,
    buffer: Buffer,
    opts: { dryRun?: boolean } = {},
  ) {
    let records: Record<string, string>[];
    try {
      records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        trim: true,
      });
    } catch (e) {
      throw new BadRequestException(
        `Could not read the CSV: ${(e as Error).message}`,
      );
    }
    if (!records.length) throw new BadRequestException('File is empty');

    // One query for all bibs instead of one per row
    const bibs = records
      .map((r) => pick(r, 'bib'))
      .filter((b): b is string => !!b);
    if (!bibs.length) {
      throw new BadRequestException(
        'No bib column found. Expected a header like "Bib" or "Bib No".',
      );
    }

    const registrations = await this.registrationsRepo.find({
      where: { eventId, bibNumber: In(bibs) },
      relations: ['category'], // assumes Registration -> category with distanceKm
    });
    const byBib = new Map(registrations.map((r) => [r.bibNumber, r]));

    const rows: ImportResultRowDto[] = [];
    const unmatched: string[] = [];
    const duplicates: string[] = [];
    const skipped: { bib: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const r of records) {
      const bib = pick(r, 'bib');
      if (!bib) continue;

      if (seen.has(bib)) {
        duplicates.push(bib);
        continue; // keep the first occurrence only
      }
      seen.add(bib);

      const reg = byBib.get(bib);
      if (!reg) {
        unmatched.push(bib);
        continue;
      }

      const status = pick(r, 'status')?.toUpperCase();
      if (status && ['DNF', 'DNS', 'DSQ'].includes(status)) {
        skipped.push({ bib, reason: status });
        continue;
      }

      const chip = toSeconds(pick(r, 'chipTime'));
      const gun = toSeconds(pick(r, 'gunTime'));
      const official = chip ?? gun; // chip time is official when present
      if (official === null) {
        skipped.push({ bib, reason: 'No valid time' });
        continue;
      }

      const km = Number((reg as any).category?.distanceKm) || 0;
      rows.push({
        registrationId: reg.id,
        officialTime: formatTime(official),
        chipTime: chip !== null ? formatTime(chip) : undefined,
        gunTime: gun !== null ? formatTime(gun) : undefined,
        pacePerKm: km ? formatPace(official, km) : undefined,
        distanceKm: km || undefined,
      } as any);
    }

    const summary = {
      totalRows: records.length,
      valid: rows.length,
      unmatchedBibs: unmatched,
      duplicateBibs: duplicates,
      skipped,
    };

    if (opts.dryRun) return { dryRun: true, ...summary };

    const saved = await this.importResults(eventId, rows);
    await this.recomputeRanks(eventId);
    return { dryRun: false, imported: saved.length, ...summary };
  }

  /**
   * Recalculate overall and category ranks from official time.
   * Ties share a rank (1, 2, 2, 4).
   * NOTE: this overwrites manual placings set via setPlaceByBib.
   */
  async recomputeRanks(eventId: string) {
    const results = await this.resultsRepo
      .createQueryBuilder('result')
      .innerJoinAndSelect('result.registration', 'registration')
      .where('registration.eventId = :eventId', { eventId })
      .getMany();

    const timed = results
      .map((r) => ({ r, sec: toSeconds(r.officialTime as any) }))
      .filter((x) => x.sec !== null)
      .sort((a, b) => a.sec! - b.sec!);

    const rank = (list: typeof timed) => {
      const out = new Map<string, number>();
      list.forEach((x, i) => {
        const prev = list[i - 1];
        out.set(
          x.r.id,
          prev && prev.sec === x.sec ? out.get(prev.r.id)! : i + 1,
        );
      });
      return out;
    };

    const overall = rank(timed);

    const byCategory = new Map<string, typeof timed>();
    for (const x of timed) {
      const cat = (x.r.registration as any).categoryId;
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), x]);
    }
    const categoryRanks = new Map<string, number>();
    for (const list of byCategory.values()) {
      rank(list).forEach((v, k) => categoryRanks.set(k, v));
    }

    for (const { r } of timed) {
      r.overallRank = overall.get(r.id)!;
      r.categoryRank = categoryRanks.get(r.id)!;
    }
    await this.resultsRepo.save(timed.map((x) => x.r));
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getResultForRunner(registrationId: string) {
    const result = await this.resultsRepo.findOne({
      where: { registrationId },
      relations: ['registration'],
    });
    if (!result) throw new NotFoundException('Result not found');
    return result;
  }

  async getEventLeaderboard(
    eventId: string,
    filters: {
      scope?: 'overall' | 'category' | 'age_group' | 'gender';
      categoryId?: string;
    },
  ) {
    const qb = this.resultsRepo
      .createQueryBuilder('result')
      .innerJoinAndSelect('result.registration', 'registration')
      .where('registration.eventId = :eventId', { eventId });

    if (filters.scope === 'category' && filters.categoryId) {
      qb.andWhere('registration.categoryId = :categoryId', {
        categoryId: filters.categoryId,
      });
      qb.orderBy('result.categoryRank', 'ASC');
    } else if (filters.scope === 'age_group') {
      qb.orderBy('result.ageGroupRank', 'ASC');
    } else {
      qb.orderBy('result.overallRank', 'ASC');
    }

    return qb.getMany();
  }

  // Precomputed via scheduled job in production - this is the synchronous
  // fallback query the job would otherwise materialize into a cache table.
  async getGlobalLeaderboard(filters: {
    by?: 'distance' | 'events' | 'fastest';
  }) {
    const qb = this.registrationsRepo
      .createQueryBuilder('registration')
      .innerJoin('registration.result', 'result')
      .select('registration.runnerUserId', 'userId')
      .addSelect('SUM(result.distanceKm)', 'totalDistance')
      .addSelect('COUNT(result.id)', 'totalEvents')
      // Names come from the account's runner profile (not the per-registration participant
      // name, which can be someone else) so a leaderboard row is identifiable.
      .leftJoin(
        RunnerProfile,
        'profile',
        'profile.userId = registration.runnerUserId',
      )
      .addSelect('profile.firstName', 'firstName')
      .addSelect('profile.lastName', 'lastName')
      .groupBy('registration.runnerUserId')
      .addGroupBy('profile.firstName')
      .addGroupBy('profile.lastName');

    if (filters.by === 'events') {
      qb.orderBy('totalEvents', 'DESC');
    } else {
      qb.orderBy('totalDistance', 'DESC');
    }

    return qb.limit(100).getRawMany();
  }

  // -------------------------------------------------------------------------
  // Manual place setting by bib
  // -------------------------------------------------------------------------

  async setPlaceByBib(eventId: string, bibNumber: string, dto: SetPlaceDto) {
    if (
      dto.overallRank === undefined &&
      dto.categoryRank === undefined &&
      dto.ageGroupRank === undefined
    ) {
      throw new BadRequestException('Provide at least one rank to set');
    }

    const registration = await this.registrationsRepo.findOne({
      where: { eventId, bibNumber },
    });
    if (!registration) {
      throw new NotFoundException(
        `No registration with bib ${bibNumber} in this event`,
      );
    }

    const result = await this.resultsRepo.findOne({
      where: { registrationId: registration.id },
    });
    if (!result) {
      throw new NotFoundException(
        `Bib ${bibNumber} has no result yet. Import results first.`,
      );
    }

    // Only overwrite the ranks that were actually sent
    if (dto.overallRank !== undefined) result.overallRank = dto.overallRank;
    if (dto.categoryRank !== undefined) result.categoryRank = dto.categoryRank;
    if (dto.ageGroupRank !== undefined) result.ageGroupRank = dto.ageGroupRank;

    const saved = await this.resultsRepo.save(result);

    // Optional: let Certificates/Notifications know the placing changed
    this.eventEmitter.emit('result.place_updated', {
      registrationId: registration.id,
      userId: registration.runnerUserId,
      resultId: saved.id,
    });

    return saved;
  }

  async setPlacesByBib(eventId: string, rows: SetPlaceByBibRowDto[]) {
    const updated: Result[] = [];
    const errors: { bibNumber: string; error: string }[] = [];

    for (const { bibNumber, ...dto } of rows) {
      try {
        updated.push(await this.setPlaceByBib(eventId, bibNumber, dto));
      } catch (e) {
        errors.push({ bibNumber, error: (e as Error).message });
      }
    }

    return { updated, errors };
  }
}