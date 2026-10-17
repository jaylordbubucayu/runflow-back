import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Registration } from './entities/registration.entity';
import { User } from '../users/entities/user.entity';
import { RunnerProfile } from '../users/entities/runner-profile.entity';
import { RegistrationsService } from './registrations.service';
import { RegistrationsController } from './registrations.controller';
import { EventsModule } from '../events/events.module';
import { PaymentsModule } from '../payments/payments.module';
import { QrService } from '../common/services/qr.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Registration, User, RunnerProfile]),
    EventsModule,
    forwardRef(() => PaymentsModule),
  ],
  controllers: [RegistrationsController],
  providers: [RegistrationsService, QrService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}