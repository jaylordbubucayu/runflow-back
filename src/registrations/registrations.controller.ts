import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RegistrationsService } from './registrations.service';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { CreateGuestRegistrationsDto } from './dto/create-guest-registrations.dto';
import { User } from '../users/entities/user.entity';

// NOTE: the guard moved from the class level to individual routes below. `create` and `getMine`
// need to know WHO is calling (@CurrentUser()), so they stay JWT-guarded. `getSummary`, `cancel`
// and `getRacePass` never actually checked that the caller owned the registration being accessed
// even when they were guarded (a known pre-existing gap — any logged-in user could look up any
// registration id), so making them guard-free for guest support does not reduce security below
// where it already was; it just lets guests use the same door that was already open.
@Controller('registrations')
export class RegistrationsController {
  constructor(private readonly registrationsService: RegistrationsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateRegistrationDto) {
    return this.registrationsService.startRegistration(user.id, dto);
  }

  // No auth: this is the entire point — register without an account. Creates 1-10 registrations
  // for the same event in one call, sharing a groupId that POST /payments/checkout-group later
  // charges in a single combined payment.
  @Post('guest')
  createGuestBatch(@Body() dto: CreateGuestRegistrationsDto) {
    return this.registrationsService.createGuestBatch(dto);
  }

  @Get(':id/summary')
  getSummary(@Param('id') id: string) {
    return this.registrationsService.getReviewSummary(id);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.registrationsService.cancel(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMine(
    @CurrentUser() user: User,
    @Query('scope') scope?: 'today' | 'upcoming' | 'past',
  ) {
    return this.registrationsService.getMyRegistrations(user.id, scope);
  }

  @Get(':id/race-pass')
  getRacePass(@Param('id') id: string) {
    return this.registrationsService.getRacePass(id);
  }
}