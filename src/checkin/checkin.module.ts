import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CheckIn } from './entities/check-in.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { CheckInService } from './checkin.service';
import { CheckInController } from './checkin.controller';
import { QrService } from '../common/services/qr.service';

@Module({
  imports: [TypeOrmModule.forFeature([CheckIn, Registration])],
  controllers: [CheckInController],
  providers: [CheckInService, QrService],
  exports: [CheckInService],
})
export class CheckInModule {}
