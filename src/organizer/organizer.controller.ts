import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums';
import { User } from '../users/entities/user.entity';
import { OrganizerService } from './organizer.service';
import { OrganizerEarningsService } from './organizer-earnings.service';
import { OrganizerPayoutsService } from './organizer-payouts.service';
import { UpsertPayoutAccountDto } from './dto/upsert-payout-account.dto';
import { RequestPayoutDto } from './dto/request-payout.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER)
@Controller('organizer')
export class OrganizerController {
  constructor(
    private readonly organizerService: OrganizerService,
    private readonly earningsService: OrganizerEarningsService,
    private readonly payoutsService: OrganizerPayoutsService,
  ) {}

  @Get('overview')
  getOverview(@CurrentUser() user: User) {
    return this.organizerService.getOverview(user.id);
  }

  @Get('participants')
  listParticipants(
    @CurrentUser() user: User,
    @Query('eventId') eventId?: string,
  ) {
    return this.organizerService.listParticipants(user.id, eventId);
  }

  @Get('payments')
  listPayments(@CurrentUser() user: User, @Query('eventId') eventId?: string) {
    return this.organizerService.listPayments(user.id, eventId);
  }

  // --- Payout account ----------------------------------------------------------------------

  @Get('payout-account')
  getPayoutAccount(@CurrentUser() user: User) {
    return this.organizerService.getPayoutAccount(user.id);
  }

  @Post('payout-account')
  createPayoutAccount(
    @CurrentUser() user: User,
    @Body() dto: UpsertPayoutAccountDto,
  ) {
    return this.organizerService.createPayoutAccount(user.id, dto);
  }

  @Patch('payout-account')
  updatePayoutAccount(
    @CurrentUser() user: User,
    @Body() dto: UpsertPayoutAccountDto,
  ) {
    return this.organizerService.updatePayoutAccount(user.id, dto);
  }

  @Delete('payout-account')
  @HttpCode(204)
  deletePayoutAccount(@CurrentUser() user: User) {
    return this.organizerService.deletePayoutAccount(user.id);
  }

  /** Connects (or re-connects) the payout account to PayMongo's linked-account API. Idempotent. */
  @Post('payout-account/connect')
  connectPayoutAccount(@CurrentUser() user: User) {
    return this.organizerService.connectPayoutAccount(user.id);
  }

  /** Re-reads the linked account's activation status from PayMongo. */
  @Post('payout-account/refresh')
  refreshPayoutAccount(@CurrentUser() user: User) {
    return this.organizerService.refreshPayoutAccount(user.id);
  }

  // --- Earnings & payouts ------------------------------------------------------------------

  /**
   * Powers the earnings card: total payments, platform fees, net earnings (total payments
   * excluding the platform fee), what is paid out / pending, and the withdrawable balance —
   * plus the same split per event.
   */
  @Get('earnings')
  async getEarnings(@CurrentUser() user: User) {
    const orgId = await this.organizerService.orgIdFor(user.id);
    if (!orgId) return null;
    const [summary, events] = await Promise.all([
      this.earningsService.getSummary(orgId),
      this.earningsService.getEventBreakdown(orgId),
    ]);
    return { ...summary, events };
  }

  @Get('payouts')
  listPayouts(@CurrentUser() user: User) {
    return this.payoutsService.list(user.id);
  }

  /** Withdraws `amountCentavos`, or the whole available balance when omitted. */
  @Post('payouts')
  requestPayout(@CurrentUser() user: User, @Body() dto: RequestPayoutDto) {
    return this.payoutsService.requestPayout(user.id, dto);
  }

  @Post('payouts/:id/refresh')
  refreshPayout(@CurrentUser() user: User, @Param('id') id: string) {
    return this.payoutsService.refresh(user.id, id);
  }
}