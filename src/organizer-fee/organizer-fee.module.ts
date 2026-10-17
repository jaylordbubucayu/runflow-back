import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrganizerFeeConfig } from './entities/organizer-fee.entity';
import { Payment } from '../payments/entities/payment.entity';
import { OrganizerFeeService } from './organizer-fee.service';

/**
 * Deliberately tiny and dependency-free (repositories only) so EventsModule can import it to gate
 * publishing without creating a cycle with PaymentsModule -> RegistrationsModule -> EventsModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([OrganizerFeeConfig, Payment])],
  providers: [OrganizerFeeService],
  exports: [OrganizerFeeService],
})
export class OrganizerFeeModule {}