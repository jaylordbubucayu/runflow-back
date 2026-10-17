import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { UpsertPayoutAccountDto } from './dto/upsert-payout-account.dto'

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER)
@Controller('organizer')
export class OrganizerController {
  constructor(private readonly organizerService: OrganizerService) {}

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
}