export const STRAVA_UPLOAD_QUEUE = 'strava-uploads';

export enum StravaActivityStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  /**
   * The outcome at Strava is unknown (timeout, 5xx, crash mid-request, polling gave up).
   * Never auto-retried: a blind retry of a non-idempotent create could post a duplicate.
   */
  NEEDS_REVIEW = 'needs_review',
}

export enum StravaActivityKind {
  MANUAL = 'manual',
  UPLOAD = 'upload',
}

/** Statuses in which a registration "owns" its Strava activity (blocks a second one). */
export const ACTIVE_STATUSES = [
  StravaActivityStatus.PENDING,
  StravaActivityStatus.PROCESSING,
  StravaActivityStatus.COMPLETED,
  StravaActivityStatus.NEEDS_REVIEW,
];

/** Only scope we request. Everything else is deliberately left out (least privilege). */
export const REQUIRED_SCOPE = 'activity:write';

/** sport_type values we allow for a race-day activity (Strava's SportType enum members). */
export const ALLOWED_SPORT_TYPES = ['Run', 'TrailRun', 'Walk', 'Hike'] as const;
export type AllowedSportType = (typeof ALLOWED_SPORT_TYPES)[number];

/** Machine-readable codes returned in the `error` field of error bodies. */
export const StravaErrorCode = {
  NOT_CONFIGURED: 'STRAVA_NOT_CONFIGURED',
  NOT_CONNECTED: 'STRAVA_NOT_CONNECTED',
  REVOKED: 'STRAVA_REVOKED',
  MISSING_SCOPE: 'STRAVA_MISSING_SCOPE',
  ACCESS_DENIED: 'STRAVA_ACCESS_DENIED',
  INVALID_STATE: 'STRAVA_INVALID_STATE',
  ATHLETE_LINKED: 'STRAVA_ATHLETE_LINKED',
  RATE_LIMITED: 'STRAVA_RATE_LIMITED',
  UNAVAILABLE: 'STRAVA_UNAVAILABLE',
  UPSTREAM: 'STRAVA_UPSTREAM_ERROR',
  NOT_ELIGIBLE: 'STRAVA_NOT_ELIGIBLE',
  EVENT_NOT_STARTED: 'STRAVA_EVENT_NOT_STARTED',
  WRONG_DATE: 'STRAVA_ACTIVITY_DATE_MISMATCH',
  DUPLICATE: 'STRAVA_DUPLICATE_ACTIVITY',
  INVALID_FILE: 'STRAVA_INVALID_FILE',
  NOT_RETRYABLE: 'STRAVA_NOT_RETRYABLE',
  CONFIRMATION_REQUIRED: 'STRAVA_CONFIRMATION_REQUIRED',
} as const;
