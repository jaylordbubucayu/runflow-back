import { Transform, Type } from 'class-transformer';
import {
  Equals, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { ALLOWED_SPORT_TYPES } from '../strava.constants';

const truthy = ({ value }: { value: unknown }) => value === true || value === 'true';
const ID = /^\d{1,20}$/;

export class StravaConnectQueryDto {
  @IsOptional() @IsString() @MaxLength(255)
  returnTo?: string;
}

export class StravaCallbackDto {
  @IsString() @MinLength(16) @MaxLength(128)
  state: string;

  @IsOptional() @IsString() @MaxLength(512)
  code?: string;

  @IsOptional() @IsString() @MaxLength(255)
  scope?: string;

  @IsOptional() @IsString() @MaxLength(64)
  error?: string;
}

export class CreateManualActivityDto {
  @Matches(ID) registrationId: string;

  /** Client-generated UUID per submit attempt: makes double-clicks / replays idempotent. */
  @IsUUID('4') clientRequestId: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  name: string;

  @IsIn(ALLOWED_SPORT_TYPES as unknown as string[])
  sportType: string;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(100) @Max(250_000)
  distanceMeters: number;

  @Type(() => Number) @IsInt() @Min(60) @Max(86_400)
  elapsedTimeSeconds: number;

  /** Local wall-clock start, e.g. 2026-10-11T05:30 or 2026-10-11T05:30:00 (no zone). */
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
  startDateLocal: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  /** The runner explicitly attests this is a real activity they completed. */
  @Equals(true, { message: 'You must confirm this is a real activity before it is published.' })
  confirmed: boolean;
}

export class UploadActivityDto {
  @Matches(ID) registrationId: string;
  @IsUUID('4') clientRequestId: string;

  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;

  // multipart fields arrive as strings
  @Transform(truthy) @IsBoolean() @Equals(true, { message: 'You must confirm this is a real activity before it is published.' })
  confirmed: boolean;
}

export class RetryActivityDto {
  /** Required for needs_review records: the runner checked Strava and the activity is not there. */
  @IsOptional() @IsBoolean()
  confirmNotOnStrava?: boolean;
}
