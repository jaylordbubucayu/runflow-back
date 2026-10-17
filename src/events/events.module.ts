import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from './entities/event.entity';
import { EventCategory } from './entities/event-category.entity';
import { EventPrize } from './entities/event-prize.entity';
import { EventFreebie } from './entities/event-freebie.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { OrganizationOwnerGuard } from '../auth/guards/organization-owner.guard';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EventCoupon } from './entities/event-coupon.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { OrganizerFeeModule } from '../organizer-fee/organizer-fee.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Event,
      EventCategory,
      EventPrize,
      EventFreebie,
      EventCheckpoint,
      Organization,
      EventCoupon,
      Registration,
    ]),
    OrganizationsModule,
    OrganizerFeeModule,
  ],
  controllers: [EventsController],
  providers: [EventsService, OrganizationOwnerGuard],
  exports: [EventsService],
})
export class EventsModule {}