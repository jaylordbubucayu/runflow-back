import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OrganizationOwnerGuard } from '../auth/guards/organization-owner.guard';
import { UserRole } from '../common/enums';
import { User } from '../users/entities/user.entity';
import { OrganizerEventPaymentsService } from './organizer-event-payments.service';

/**
 * Organizer platform-fee endpoints. Publishing itself is the existing POST /api/events/:id/publish
 * (now gated on a verified paid fee), so there is deliberately no second publish route here.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER)
@Controller('organizer')
export class OrganizerEventPaymentsController {
  constructor(private readonly service: OrganizerEventPaymentsService) {}

  /** The fee the UI displays: amount comes from the backend, never from the frontend. */
  @Get('platform-fee')
  getQuote() {
    return this.service.getQuote();
  }

  @UseGuards(OrganizationOwnerGuard)
  @Get('events/:id/payment-status')
  getStatus(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.getStatus(id, user.id);
  }

  @UseGuards(OrganizationOwnerGuard)
  @Post('events/:id/payment-link')
  createPaymentLink(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.createPaymentLink(id, user.id);
  }
}
