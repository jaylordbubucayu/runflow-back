import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import { StravaConfig } from './strava.config';
import { StravaActivity } from './entities/strava-activity.entity';
import { StravaConnection } from './entities/strava-connection.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { EventStatus, RegistrationStatus } from '../common/enums';
import { StravaTokenService } from './strava-token.service';
import { StravaHttpClient, StravaUploadResponse } from './strava-http.client';
import { StravaApiError, mapStravaError, stravaError } from './strava.errors';
import {
  REQUIRED_SCOPE, STRAVA_UPLOAD_QUEUE, StravaActivityKind, StravaActivityStatus, StravaErrorCode,
} from './strava.constants';
import { CreateManualActivityDto, RetryActivityDto, UploadActivityDto } from './dto/strava.dto';
import { UploadedFileLike, validateActivityFile } from './strava-file.validator';
import {
  dateToWallClock, dayDiff, eventHasStarted, localDateInZone, normalizeDateOnly, nowLocalIso, wallClockToDate,
} from './strava-dates';
import { parseScopes } from './strava-auth.service';

const MAX_POLLS = 40; // ~5 minutes with the schedule below
const STALE_MS = 5 * 60 * 1000;
const MAX_SPEED_MPS = 12; // ~43 km/h: anything faster is a typo, not a run
const AMBIGUOUS_MESSAGE =
  "We couldn't confirm whether Strava received this activity. Check your Strava profile before trying again, so you don't end up with a duplicate.";

export function pollDelayMs(attempt: number): number {
  return attempt <= 5 ? 2_000 : attempt <= 15 ? 5_000 : 10_000;
}

/** Strava error text is short and user-oriented, but never trust it: strip markup and cap length. */
function safeUpstreamText(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

@Injectable()
export class StravaActivityService {
  private readonly logger = new Logger(StravaActivityService.name);

  constructor(
    private readonly cfg: StravaConfig,
    @InjectRepository(StravaActivity) private readonly repo: Repository<StravaActivity>,
    @InjectRepository(Registration) private readonly registrations: Repository<Registration>,
    private readonly tokens: StravaTokenService,
    private readonly client: StravaHttpClient,
    @InjectQueue(STRAVA_UPLOAD_QUEUE) private readonly queue: Queue,
  ) {}

  // ---------------------------------------------------------------------------------------
  // Eligibility & ownership
  // ---------------------------------------------------------------------------------------

  /**
   * Ownership comes from the JWT user, never from the request body. A registration that isn't
   * yours is a 404 (not 403) so ids can't be probed.
   */
  private async loadEligibleRegistration(userId: string, registrationId: string) {
    const reg = await this.registrations.findOne({
      where: { id: registrationId, runnerUserId: userId },
      relations: ['event', 'category'],
    });
    if (!reg) throw new NotFoundException('Registration not found');

    const notEligible = (message: string, code: string = StravaErrorCode.NOT_ELIGIBLE) =>
      stravaError(HttpStatus.BAD_REQUEST, code, message);

    // Guest/group registrations hang off a shadow account that owns several different people's
    // entries; the account holder is not necessarily the person who ran.
    if (reg.groupId) throw notEligible('Strava publishing is not available for group guest registrations.');
    if (![RegistrationStatus.REGISTERED, RegistrationStatus.CHECKED_IN, RegistrationStatus.COMPLETED].includes(reg.status)) {
      throw notEligible('Only paid, active registrations can be linked to a Strava activity.');
    }
    if ([EventStatus.CANCELLED, EventStatus.DRAFT].includes(reg.event.status)) {
      throw notEligible('This event is not available for Strava activities.');
    }
    const eventDate = normalizeDateOnly(reg.event.eventDate as unknown as string | Date);
    if (!eventHasStarted(eventDate, this.cfg.eventTimezone)) {
      throw notEligible('This event has not taken place yet. You can add your activity on the event day.', StravaErrorCode.EVENT_NOT_STARTED);
    }
    return { reg, eventDate };
  }

  private assertActivityDay(activityLocalDate: string, eventDate: string) {
    if (Math.abs(dayDiff(activityLocalDate, eventDate)) > this.cfg.dateToleranceDays) {
      throw stravaError(
        HttpStatus.BAD_REQUEST,
        StravaErrorCode.WRONG_DATE,
        this.cfg.dateToleranceDays === 0
          ? `The activity must have started on the event day (${eventDate}).`
          : `The activity must have started within ${this.cfg.dateToleranceDays} day(s) of the event day (${eventDate}).`,
      );
    }
  }

  private async requireWritableConnection(userId: string): Promise<StravaConnection> {
    const conn = await this.tokens.getActiveConnection(userId);
    if (!parseScopes(conn.scopes).includes(REQUIRED_SCOPE)) {
      throw stravaError(HttpStatus.FORBIDDEN, StravaErrorCode.MISSING_SCOPE, 'RunFlow does not have permission to add activities to your Strava. Please reconnect Strava.');
    }
    return conn;
  }

  // ---------------------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------------------

  private isDup(err: any, key?: string): boolean {
    return err?.code === 'ER_DUP_ENTRY' && (!key || String(err?.sqlMessage ?? err?.message).includes(key));
  }

  private async insertRecord(data: Partial<StravaActivity>): Promise<StravaActivity> {
    try {
      return await this.repo.save(this.repo.create(data));
    } catch (err: any) {
      if (this.isDup(err, 'UQ_strava_activities_user_request')) {
        // Lost a race with an identical request: that request owns the work, so just return it.
        const same = await this.repo.findOne({ where: { userId: data.userId, clientRequestId: data.clientRequestId } });
        if (same) return Object.assign(same, { __replay: true });
      }
      if (this.isDup(err)) {
        throw stravaError(
          HttpStatus.CONFLICT,
          StravaErrorCode.DUPLICATE,
          this.isDup(err, 'active_file')
            ? 'This file has already been submitted to Strava.'
            : 'This registration already has a Strava activity. Open it from your activity history instead of adding another.',
        );
      }
      throw err;
    }
  }

  private async setFailed(rec: StravaActivity, code: string, message: string, retryable: boolean) {
    await this.repo.update(rec.id, {
      status: StravaActivityStatus.FAILED, errorCode: code, errorMessage: message.slice(0, 255), retryable,
      activeRegistrationKey: null, activeFileKey: null,
    });
  }

  private async setNeedsReview(rec: StravaActivity, code: string, message: string) {
    // Active keys are kept on purpose: the registration stays locked until the runner resolves it.
    await this.repo.update(rec.id, {
      status: StravaActivityStatus.NEEDS_REVIEW, errorCode: code, errorMessage: message.slice(0, 255), retryable: false,
    });
  }

  /**
   * One rule for every outcome of a request that was *sent*:
   *  - definitely not processed (4xx, DNS/refused, our own pre-flight)  -> failed (maybe retryable)
   *  - unknown (timeout, reset, 5xx)                                    -> needs_review, NEVER auto-retried
   */
  private async recordSendFailure(rec: StravaActivity, err: unknown) {
    if (err instanceof StravaApiError && !err.definitelyNotProcessed) {
      this.logger.warn(`Strava request outcome unknown for activity ${rec.id}: ${err.kind} ${err.status ?? ''}`);
      return this.setNeedsReview(rec, StravaErrorCode.UNAVAILABLE, AMBIGUOUS_MESSAGE);
    }
    const http = mapStravaError(err);
    const body = http.getResponse() as { error?: string; message?: string };
    const rejected = err instanceof StravaApiError && err.kind === 'http' && [400, 404, 422].includes(err.status ?? 0);
    // A rejected payload won't succeed unchanged; everything else (auth/rate-limit/down) can be retried.
    return this.setFailed(rec, body.error ?? StravaErrorCode.UPSTREAM, body.message ?? 'Strava could not add this activity.', !rejected);
  }

  private async complete(rec: StravaActivity, patch: Partial<StravaActivity>) {
    try {
      await this.repo.update(rec.id, {
        ...patch, status: StravaActivityStatus.COMPLETED, errorCode: null, errorMessage: null, retryable: false,
      });
    } catch (err: any) {
      if (this.isDup(err, 'UQ_strava_activities_strava_activity_id')) {
        return this.setFailed(rec, StravaErrorCode.DUPLICATE, 'That Strava activity is already linked to another RunFlow record.', false);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Workflow A — manual activity
  // ---------------------------------------------------------------------------------------

  async createManual(userId: string, dto: CreateManualActivityDto) {
    const replay = await this.repo.findOne({ where: { userId, clientRequestId: dto.clientRequestId } });
    if (replay) return this.view(replay);

    const { eventDate } = await this.loadEligibleRegistration(userId, dto.registrationId);
    const startLocal = dto.startDateLocal.length === 16 ? `${dto.startDateLocal}:00` : dto.startDateLocal;
    if (Number.isNaN(wallClockToDate(startLocal).getTime())) {
      throw stravaError(400, StravaErrorCode.WRONG_DATE, 'That start time is not valid.');
    }
    if (startLocal > nowLocalIso(this.cfg.eventTimezone)) {
      throw stravaError(400, StravaErrorCode.WRONG_DATE, 'The start time cannot be in the future.');
    }
    this.assertActivityDay(startLocal.slice(0, 10), eventDate);
    if (dto.distanceMeters / dto.elapsedTimeSeconds > MAX_SPEED_MPS) {
      throw stravaError(400, StravaErrorCode.WRONG_DATE, 'That distance and time imply an impossible pace. Please double-check them.');
    }
    const conn = await this.requireWritableConnection(userId);

    const rec = await this.insertRecord({
      userId, registrationId: dto.registrationId, stravaConnectionId: conn.id, kind: StravaActivityKind.MANUAL,
      clientRequestId: dto.clientRequestId, activityType: dto.sportType, activityName: dto.name.trim(),
      description: dto.description?.trim() || null, distanceMeters: String(dto.distanceMeters),
      elapsedTimeSeconds: dto.elapsedTimeSeconds, startDate: wallClockToDate(startLocal),
      status: StravaActivityStatus.PENDING, activeRegistrationKey: dto.registrationId,
    });
    if ((rec as any).__replay) return this.view(rec);

    await this.sendManual(rec);
    return this.view((await this.repo.findOne({ where: { id: rec.id } }))!);
  }

  private async sendManual(rec: StravaActivity) {
    // Exactly one caller can move pending -> processing, so a record is sent at most once.
    const claimed = await this.repo.update({ id: rec.id, status: StravaActivityStatus.PENDING }, { status: StravaActivityStatus.PROCESSING });
    if (!claimed.affected) return;
    try {
      const act = await this.tokens.withToken(rec.userId, (token) =>
        this.client.createActivity(token, {
          name: rec.activityName!, sport_type: rec.activityType!,
          start_date_local: dateToWallClock(rec.startDate)!, elapsed_time: rec.elapsedTimeSeconds!,
          distance: Number(rec.distanceMeters), description: rec.description ?? undefined,
        }),
      );
      await this.complete(rec, {
        stravaActivityId: String(act.id),
        movingTimeSeconds: act.moving_time ?? null,
      });
    } catch (err) {
      await this.recordSendFailure(rec, err);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Workflow B — recorded file upload
  // ---------------------------------------------------------------------------------------

  async createUpload(userId: string, dto: UploadActivityDto, file: UploadedFileLike | undefined) {
    const replay = await this.repo.findOne({ where: { userId, clientRequestId: dto.clientRequestId } });
    if (replay) return this.view(replay);

    const validated = validateActivityFile(file, this.cfg.uploadMaxBytes);
    const { eventDate } = await this.loadEligibleRegistration(userId, dto.registrationId);
    if (validated.startInstant) {
      if (validated.startInstant.getTime() > Date.now() + 5 * 60 * 1000) {
        throw stravaError(400, StravaErrorCode.WRONG_DATE, 'This file starts in the future.');
      }
      this.assertActivityDay(localDateInZone(validated.startInstant, this.cfg.eventTimezone), eventDate);
    }
    const conn = await this.requireWritableConnection(userId);

    const rec = await this.insertRecord({
      userId, registrationId: dto.registrationId, stravaConnectionId: conn.id, kind: StravaActivityKind.UPLOAD,
      clientRequestId: dto.clientRequestId, activityName: dto.name?.trim() || null, description: dto.description?.trim() || null,
      fileSha256: validated.sha256, status: StravaActivityStatus.PENDING,
      activeRegistrationKey: dto.registrationId, activeFileKey: `${userId}:${validated.sha256}`,
    });
    if ((rec as any).__replay) return this.view(rec);

    const claimed = await this.repo.update({ id: rec.id, status: StravaActivityStatus.PENDING }, { status: StravaActivityStatus.PROCESSING });
    if (claimed.affected) {
      try {
        const up = await this.tokens.withToken(userId, (token) =>
          this.client.createUpload(token, {
            file: file!.buffer, dataType: validated.type, externalId: `runflow-${rec.id}`,
            name: rec.activityName ?? undefined, description: rec.description ?? undefined,
          }),
        );
        await this.applyUploadState(rec, up, true);
      } catch (err) {
        await this.recordSendFailure(rec, err);
      }
    }
    // The file buffer lives only in memory for this request: nothing is written to disk.
    return this.view((await this.repo.findOne({ where: { id: rec.id } }))!);
  }

  /** Interprets an upload response (from POST or from polling). Returns whether it is settled. */
  private async applyUploadState(rec: StravaActivity, up: StravaUploadResponse, enqueueNext: boolean): Promise<'done' | 'pending'> {
    const uploadId = String(up.id_str ?? up.id);
    if (rec.stravaUploadId !== uploadId) await this.repo.update(rec.id, { stravaUploadId: uploadId });
    rec.stravaUploadId = uploadId;

    if (up.activity_id != null && !up.error) {
      await this.complete(rec, { stravaActivityId: String(up.activity_id) });
      return 'done';
    }
    if (up.error) {
      // Strava already holds an identical activity for this athlete: it's the runner's own data,
      // so link to it rather than reporting a failure.
      const dup = /duplicate of activity (\d+)/i.exec(up.error);
      if (dup) {
        await this.complete(rec, { stravaActivityId: dup[1] });
        return 'done';
      }
      await this.setFailed(rec, 'STRAVA_UPLOAD_REJECTED', `Strava could not process this file: ${safeUpstreamText(up.error)}`, false);
      return 'done';
    }
    if (/deleted/i.test(up.status ?? '')) {
      await this.setFailed(rec, 'STRAVA_UPLOAD_DELETED', 'The activity was deleted on Strava.', false);
      return 'done';
    }
    if (enqueueNext) await this.enqueuePoll(rec.id, pollDelayMs(1), 0);
    return 'pending';
  }

  async enqueuePoll(activityId: string, delayMs: number, attempt: number) {
    await this.queue.add('poll', { activityId }, {
      delay: delayMs, jobId: `poll-${activityId}-${attempt}`, removeOnComplete: true, removeOnFail: 100,
    });
  }

  /** One polling step, driven by the BullMQ processor. */
  async pollUpload(activityId: string): Promise<{ done: boolean; delayMs?: number }> {
    const rec = await this.repo.findOne({ where: { id: activityId } });
    if (!rec || rec.status !== StravaActivityStatus.PROCESSING || !rec.stravaUploadId) return { done: true };

    const attempt = rec.pollAttempts + 1;
    if (attempt > MAX_POLLS) {
      await this.setNeedsReview(rec, 'STRAVA_PROCESSING_TIMEOUT', 'Strava is taking longer than usual to process this upload. Use "Check status" in a few minutes.');
      return { done: true };
    }
    await this.repo.update(rec.id, { pollAttempts: attempt });

    let up: StravaUploadResponse;
    try {
      up = await this.tokens.withToken(rec.userId, (token) => this.client.getUpload(token, rec.stravaUploadId!));
    } catch (err) {
      if (err instanceof HttpException) {
        // Not connected / revoked: the upload exists at Strava but we can no longer ask about it.
        await this.setNeedsReview(rec, StravaErrorCode.REVOKED, 'Strava was disconnected before the upload finished. Reconnect Strava, then use "Check status".');
        return { done: true };
      }
      const wait = err instanceof StravaApiError && err.status === 429 ? Math.min((err.retryAfterSec ?? 60) * 1000, 15 * 60 * 1000) : pollDelayMs(attempt);
      return { done: false, delayMs: wait }; // transient: GET is idempotent, safe to poll again
    }
    const state = await this.applyUploadState(rec, up, false); // the processor schedules the next poll
    return state === 'done' ? { done: true } : { done: false, delayMs: pollDelayMs(attempt) };
  }

  // ---------------------------------------------------------------------------------------
  // Retry / resolve
  // ---------------------------------------------------------------------------------------

  async retry(userId: string, id: string, dto: RetryActivityDto) {
    const rec = await this.ownedOrThrow(userId, id);
    const notRetryable = (m: string) => stravaError(HttpStatus.CONFLICT, StravaErrorCode.NOT_RETRYABLE, m);
    const needsConfirm = () =>
      stravaError(400, StravaErrorCode.CONFIRMATION_REQUIRED, 'Please check your Strava profile first, then confirm the activity is not there.');

    if (rec.kind === StravaActivityKind.UPLOAD) {
      if (rec.status !== StravaActivityStatus.NEEDS_REVIEW) throw notRetryable('Upload the file again to retry.');
      if (rec.stravaUploadId) {
        // Safe: polling is read-only and Strava already has this upload.
        const ok = await this.repo.update({ id: rec.id, status: StravaActivityStatus.NEEDS_REVIEW }, {
          status: StravaActivityStatus.PROCESSING, pollAttempts: 0, errorCode: null, errorMessage: null,
        });
        if (!ok.affected) throw notRetryable('This activity changed in the meantime.');
        await this.enqueuePoll(rec.id, 1_000, 0);
      } else {
        // Outcome unknown and no upload id to check. Only the runner can resolve it.
        if (!dto.confirmNotOnStrava) throw needsConfirm();
        await this.setFailed(rec, 'STRAVA_UPLOAD_UNCONFIRMED', 'Marked as not uploaded. You can upload the file again.', false);
      }
      return this.view((await this.repo.findOne({ where: { id: rec.id } }))!);
    }

    // manual
    if (rec.status === StravaActivityStatus.NEEDS_REVIEW) {
      if (!dto.confirmNotOnStrava) throw needsConfirm();
    } else if (!(rec.status === StravaActivityStatus.FAILED && rec.retryable)) {
      throw notRetryable('This activity cannot be retried.');
    }
    await this.loadEligibleRegistration(userId, rec.registrationId); // still yours, still eligible
    await this.requireWritableConnection(userId);

    try {
      const claimed = await this.repo.update({ id: rec.id, status: rec.status }, {
        status: StravaActivityStatus.PENDING, errorCode: null, errorMessage: null, retryable: false,
        activeRegistrationKey: rec.registrationId,
      });
      if (!claimed.affected) throw notRetryable('This activity changed in the meantime.');
    } catch (err: any) {
      if (this.isDup(err)) {
        throw stravaError(HttpStatus.CONFLICT, StravaErrorCode.DUPLICATE, 'This registration already has another Strava activity.');
      }
      throw err;
    }
    await this.sendManual({ ...rec, status: StravaActivityStatus.PENDING } as StravaActivity);
    return this.view((await this.repo.findOne({ where: { id: rec.id } }))!);
  }

  // ---------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------

  private async ownedOrThrow(userId: string, id: string): Promise<StravaActivity> {
    const rec = await this.repo.findOne({ where: { id, userId } });
    if (!rec) throw new NotFoundException('Activity not found');
    return rec;
  }

  /** Lazy reconciliation of work orphaned by a crash/restart, so nothing sits "processing" forever. */
  private async reconcileStale(userId: string) {
    const cutoff = new Date(Date.now() - STALE_MS);
    // Never sent (claim happens right before sending): definitely not at Strava.
    await this.repo.update(
      { userId, status: StravaActivityStatus.PENDING, updatedAt: LessThan(cutoff) },
      { status: StravaActivityStatus.FAILED, errorCode: 'STRAVA_INTERRUPTED', errorMessage: 'This submission was interrupted before it was sent. Please try again.', retryable: false, activeRegistrationKey: null, activeFileKey: null },
    );
    // Sent, outcome unknown.
    await this.repo.update(
      { userId, status: StravaActivityStatus.PROCESSING, updatedAt: LessThan(new Date(Date.now() - 2 * STALE_MS)) },
      { status: StravaActivityStatus.NEEDS_REVIEW, errorCode: StravaErrorCode.UNAVAILABLE, errorMessage: AMBIGUOUS_MESSAGE, retryable: false },
    );
  }

  async list(userId: string, registrationId?: string) {
    await this.reconcileStale(userId);
    const rows = await this.repo.find({
      where: { userId, ...(registrationId ? { registrationId } : {}) },
      relations: ['registration', 'registration.event', 'registration.category'],
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 100,
    });
    return rows.map((r) => this.view(r));
  }

  async get(userId: string, id: string) {
    await this.reconcileStale(userId);
    const rec = await this.repo.findOne({
      where: { id, userId },
      relations: ['registration', 'registration.event', 'registration.category'],
    });
    if (!rec) throw new NotFoundException('Activity not found');
    return this.view(rec);
  }

  /** Public shape: never includes user ids, connection ids, file hashes, tokens or internal keys. */
  view(r: StravaActivity) {
    const ev = r.registration?.event;
    const resolvable = r.status === StravaActivityStatus.NEEDS_REVIEW;
    return {
      id: r.id,
      registrationId: r.registrationId,
      kind: r.kind,
      status: r.status,
      activityName: r.activityName,
      activityType: r.activityType,
      description: r.description,
      distanceMeters: r.distanceMeters != null ? Number(r.distanceMeters) : null,
      movingTimeSeconds: r.movingTimeSeconds,
      elapsedTimeSeconds: r.elapsedTimeSeconds,
      startDate: dateToWallClock(r.startDate),
      stravaActivityId: r.stravaActivityId,
      stravaUrl: r.stravaActivityId ? `https://www.strava.com/activities/${r.stravaActivityId}` : null,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      // What the UI may offer. 'retry' re-sends a failed manual activity; 'check' re-polls an
      // upload; 'resolve' needs the runner to confirm the activity is not on Strava.
      action:
        r.status === StravaActivityStatus.FAILED && r.retryable && r.kind === StravaActivityKind.MANUAL ? 'retry'
        : r.status === StravaActivityStatus.FAILED && r.kind === StravaActivityKind.UPLOAD ? 'reupload'
        : resolvable && r.kind === StravaActivityKind.UPLOAD && r.stravaUploadId ? 'check'
        : resolvable ? 'resolve' : null,
      event: ev ? { id: ev.id, name: ev.name, eventDate: normalizeDateOnly(ev.eventDate as unknown as string | Date) } : null,
      categoryName: r.registration?.category?.name ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

