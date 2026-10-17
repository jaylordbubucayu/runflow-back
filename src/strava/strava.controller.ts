import {
  Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { StravaAuthService } from './strava-auth.service';
import { StravaActivityService } from './strava-activity.service';
import { StravaRateLimit, StravaRateLimitGuard, SkipStravaEnabledCheck } from './strava-rate-limit.guard';
import {
  CreateManualActivityDto, RetryActivityDto, StravaCallbackDto, StravaConnectQueryDto, UploadActivityDto,
} from './dto/strava.dto';
import { UploadedFileLike } from './strava-file.validator';

/**
 * Every route sits behind the existing JwtAuthGuard; the user always comes from the token.
 *
 * Deviation from the brief's `GET /strava/callback`: Strava redirects the *browser* to the
 * redirect URI, and a browser redirect carries no Authorization header. A GET callback on the API
 * would therefore have to be unauthenticated and state-changing. Instead STRAVA_REDIRECT_URI is a
 * Nuxt page that forwards (code, state, scope) to POST /strava/callback with the user's JWT, and
 * the server only accepts a state that was issued to that same user.
 */
@Controller('strava')
@UseGuards(JwtAuthGuard, StravaRateLimitGuard)
export class StravaController {
  constructor(
    private readonly auth: StravaAuthService,
    private readonly activities: StravaActivityService,
  ) {}

  @Get('status')
  @SkipStravaEnabledCheck()
  status(@CurrentUser() user: User) {
    return this.auth.getStatus(user.id);
  }

  @Get('connect')
  @StravaRateLimit(10, 60_000)
  connect(@CurrentUser() user: User, @Query() q: StravaConnectQueryDto) {
    return this.auth.start(user.id, q.returnTo);
  }

  @Post('callback')
  @HttpCode(200)
  @StravaRateLimit(10, 60_000)
  callback(@CurrentUser() user: User, @Body() dto: StravaCallbackDto) {
    return this.auth.complete(user.id, dto);
  }

  @Delete('disconnect')
  @StravaRateLimit(5, 60_000)
  disconnect(@CurrentUser() user: User) {
    return this.auth.disconnect(user.id);
  }

  @Post('activities/manual')
  @StravaRateLimit(10, 60_000)
  createManual(@CurrentUser() user: User, @Body() dto: CreateManualActivityDto) {
    return this.activities.createManual(user.id, dto);
  }

  // Memory storage: the file never touches disk, so there is nothing to clean up. The size cap is
  // enforced by the MulterModule options registered in StravaModule (STRAVA_UPLOAD_MAX_BYTES).
  @Post('activities/upload')
  @StravaRateLimit(5, 60_000)
  @UseInterceptors(FileInterceptor('file'))
  upload(@CurrentUser() user: User, @Body() dto: UploadActivityDto, @UploadedFile() file?: UploadedFileLike) {
    return this.activities.createUpload(user.id, dto, file);
  }

  @Get('activities')
  @SkipStravaEnabledCheck()
  list(@CurrentUser() user: User, @Query('registrationId') registrationId?: string) {
    return this.activities.list(user.id, registrationId && /^\d{1,20}$/.test(registrationId) ? registrationId : undefined);
  }

  @Get('activities/:id')
  @SkipStravaEnabledCheck()
  get(@CurrentUser() user: User, @Param('id') id: string) {
    return this.activities.get(user.id, this.assertId(id));
  }

  @Post('activities/:id/retry')
  @HttpCode(200)
  @StravaRateLimit(10, 60_000)
  retry(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: RetryActivityDto) {
    return this.activities.retry(user.id, this.assertId(id), dto);
  }

  private assertId(id: string): string {
    if (!/^\d{1,20}$/.test(id)) throw new NotFoundException('Activity not found');
    return id;
  }
}
