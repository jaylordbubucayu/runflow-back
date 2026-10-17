import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../common/enums';
import { PaymentsService } from './payments.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { CreateGroupCheckoutDto } from './dto/create-group-checkout.dto';
import { User } from '../users/entities/user.entity';

/**
 * Runner payments. The PayMongo webhook is NOT here any more — see PaymentWebhookController
 * (POST /api/webhooks/paymongo); the old unauthenticated POST /payments/webhook is gone.
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // Only the registration's owner (or an admin) may start its payment.
  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  createCheckout(@CurrentUser() user: User, @Body() dto: CreateCheckoutDto) {
    return this.paymentsService.createCheckout(dto.registrationId, user);
  }

  // No auth: a guest group has no account. The group's random UUID is the credential.
  @Post('checkout-group')
  createGroupCheckout(@Body() dto: CreateGroupCheckoutDto) {
    return this.paymentsService.createGroupCheckout(dto.groupId);
  }

  // Declared before ':id' so 'group' / 'by-registration' are never read as payment ids.
  @Get('group/:groupId/status')
  getGroupStatus(@Param('groupId') groupId: string) {
    return this.paymentsService.getGroupStatus(groupId);
  }

  // What the confirmation page polls for a logged-in runner's own registration.
  @UseGuards(JwtAuthGuard)
  @Get('by-registration/:registrationId')
  getStatusForRegistration(@CurrentUser() user: User, @Param('registrationId') registrationId: string) {
    return this.paymentsService.getStatusForRegistration(registrationId, user);
  }

  // Previously open to anyone (and returned the raw webhook payload). Now owner/admin only.
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  getOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.paymentsService.getPaymentForActor(id, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Get()
  getForOrganizer(@Query('orgId') orgId: string, @Query() filters: any) {
    return this.paymentsService.getTransactionsForOrganizer(orgId, filters);
  }
}