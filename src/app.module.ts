import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bullmq';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { EventsModule } from './events/events.module';
import { RegistrationsModule } from './registrations/registrations.module';
import { PaymentsModule } from './payments/payments.module';
import { CheckInModule } from './checkin/checkin.module';
import { ResultsModule } from './results/results.module';
import { RunnerStatsModule } from './runner-stats/runner-stats.module';
import { CertificatesModule } from './certificates/certificates.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminModule } from './admin/admin.module';
import { UploadsModule } from './uploads/uploads.module';
import { OrganizerModule } from './organizer/organizer.module';
import { dataSourceOptions } from './data-source';
import { EmailModule } from './email/email.module';
import { join } from 'path';
import { StravaModule } from './strava/strava.module';



import { OrganizerFeeModule } from './organizer-fee/organizer-fee.module';
import { GoogleAuthModule } from './auth/google/google-auth.module';



@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: () => dataSourceOptions,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST') ?? 'localhost',
          port: parseInt(config.get('REDIS_PORT') ?? '6379', 10),
        },
      }),
    }),
    EventEmitterModule.forRoot(),

    EmailModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (c: ConfigService) => ({
    defaultFrom: c.getOrThrow('MAIL_FROM'),            // "App <no-reply@yourdomain.com>"
    smtp: {
      host: c.getOrThrow('SMTP_HOST'),
      port: +c.getOrThrow('SMTP_PORT'),
      user: c.getOrThrow('SMTP_USER'),
      pass: c.getOrThrow('SMTP_PASS'),
    },
    templatesDir: join(process.cwd(), 'src/email/templates'),   // add to nest-cli.json assets so it's copied on build
    dryRun: c.get('NODE_ENV') === 'test',
    // allowedRecipientDomains: c.get('NODE_ENV') === 'production' ? undefined : ['yourcompany.com'],
  }),
}),

    // Build order roughly follows the doc's §5 suggested order.
    AuthModule,
    UsersModule,
    OrganizationsModule,
    EventsModule,
    RegistrationsModule,
    PaymentsModule,
    CheckInModule,
    AdminModule,
    OrganizerModule,
    UploadsModule,
    ResultsModule,
    RunnerStatsModule,
    CertificatesModule,
    NotificationsModule,
    EmailModule,
    OrganizerFeeModule,
    //StravaModule,
    GoogleAuthModule
  ],
})
export class AppModule {}