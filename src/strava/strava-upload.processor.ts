import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { STRAVA_UPLOAD_QUEUE } from './strava.constants';
import { StravaActivityService } from './strava-activity.service';

/** Polls Strava's upload status (GET /uploads/{id}) until the activity is created or it fails. */
@Processor(STRAVA_UPLOAD_QUEUE)
export class StravaUploadProcessor extends WorkerHost {
  private readonly logger = new Logger(StravaUploadProcessor.name);

  constructor(private readonly activities: StravaActivityService) {
    super();
  }

  async process(job: Job<{ activityId: string }>) {
    if (job.name !== 'poll') return;
    const { activityId } = job.data;
    try {
      const r = await this.activities.pollUpload(activityId);
      if (!r.done) {
        const attempt = Number(job.id?.split('-').pop() ?? 0) + 1;
        await this.activities.enqueuePoll(activityId, r.delayMs ?? 5_000, attempt);
      }
    } catch (err) {
      // Unexpected bug/DB error: don't lose the poll loop silently, but don't spin either.
      this.logger.error(`Strava poll failed for activity ${activityId}: ${(err as Error).message}`);
      const attempt = Number(job.id?.split('-').pop() ?? 0) + 1;
      if (attempt < 40) await this.activities.enqueuePoll(activityId, 15_000, attempt);
    }
  }
}
