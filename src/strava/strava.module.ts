import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StravaConnection } from './entities/strava-connection.entity';
import { StravaActivity } from './entities/strava-activity.entity';
import { StravaOauthState } from './entities/strava-oauth-state.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { StravaConfig } from './strava.config';
import { StravaCryptoService } from './strava-crypto.service';
import { StravaHttpClient } from './strava-http.client';
import { StravaTokenService } from './strava-token.service';
import { StravaAuthService } from './strava-auth.service';
import { StravaActivityService } from './strava-activity.service';
import { StravaUploadProcessor } from './strava-upload.processor';
import { StravaRateLimitGuard } from './strava-rate-limit.guard';
import { StravaController } from './strava.controller';
import { STRAVA_UPLOAD_QUEUE } from './strava.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([StravaConnection, StravaActivity, StravaOauthState, Registration]),
    BullModule.registerQueue({ name: STRAVA_UPLOAD_QUEUE }),
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: memoryStorage(),
        limits: {
          fileSize: Number(config.get('STRAVA_UPLOAD_MAX_BYTES') ?? 10 * 1024 * 1024),
          files: 1,
          fields: 10,
          fieldSize: 4 * 1024,
        },
      }),
    }),
  ],
  controllers: [StravaController],
  providers: [
    // StravaConfig validates env at bootstrap and throws on bad values (fail fast).
    StravaConfig,
    StravaCryptoService,
    StravaHttpClient,
    StravaTokenService,
    StravaAuthService,
    StravaActivityService,
    StravaUploadProcessor,
    StravaRateLimitGuard,
  ],
})
export class StravaModule {}
