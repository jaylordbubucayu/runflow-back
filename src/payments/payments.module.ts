import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PlatformFeeConfig } from './entities/platform-fee-config.entity';
import { PaymentStatusLog } from './entities/payment-status-log.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentSettlementService } from './payment-settlement.service';
import { PaymentExpirySweeper } from './payment-expiry.sweeper';
import { RegistrationsModule } from '../registrations/registrations.module';
import { EventsModule } from '../events/events.module';
import { Event } from '../events/entities/event.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { OrganizationOwnerGuard } from '../auth/guards/organization-owner.guard';
import { PaymentWebhookController } from 'src/payments-webhook/payments-webhook.controller';
import { OrganizerFeeModule } from 'src/organizer-fee/organizer-fee.module';
import { PaymentWebhookEvent } from 'src/payments-webhook/entities/payments-webhook-event.entity';
import { PaymongoService } from './paymongo.service';
import { PaymentWebhookService } from 'src/payments-webhook/payments-webhook.service';
import { OrganizerEventPaymentsController } from 'src/organizer/organizer-event-payments.controller';
import { OrganizerEventPaymentsService } from 'src/organizer/organizer-event-payments.service';

@Module({
  imports: [
   TypeOrmModule.forFeature([
     Payment, PlatformFeeConfig, PaymentWebhookEvent, PaymentStatusLog, Event, Organization,
   ]),
    forwardRef(() => RegistrationsModule),
    EventsModule,
    OrganizerFeeModule,
  ],
  controllers: [PaymentsController, PaymentWebhookController, OrganizerEventPaymentsController],
  providers: [
    PaymongoService,
    PaymentLedgerService,
    PaymentSettlementService,
    PaymentsService,
    PaymentWebhookService,
    OrganizerEventPaymentsService,
    PaymentExpirySweeper,
    OrganizationOwnerGuard,
  ],
  exports: [PaymentsService, PaymongoService, OrganizerFeeModule],
})
export class PaymentsModule {}