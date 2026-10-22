import { Module } from '@nestjs/common';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { OrganizerEarningsService } from './organizer-earnings.service';
import { OrganizerPayoutsService } from './organizer-payouts.service';
// PaymentsModule exports PaymongoService, the only class that talks to PayMongo.
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  controllers: [OrganizerController],
  providers: [OrganizerService, OrganizerEarningsService, OrganizerPayoutsService],
})
export class OrganizerModule {}