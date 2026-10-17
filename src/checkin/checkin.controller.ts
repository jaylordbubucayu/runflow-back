import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckInService } from './checkin.service';
import { ResolveQrDto } from './dto/resolve-qr.dto';
import { CheckInDto } from './dto/check-in.dto';
import { User } from '../users/entities/user.entity';

@UseGuards(JwtAuthGuard)
@Controller('checkin')
export class CheckInController {
  constructor(private readonly checkInService: CheckInService) {}

  @Post('resolve')
  resolve(@Body() dto: ResolveQrDto) {
    return this.checkInService.resolveQr(dto.qrToken);
  }

  @Post()
  checkIn(@CurrentUser() staff: User, @Body() dto: CheckInDto) {
    return this.checkInService.checkIn(dto.registrationId, staff.id);
  }

  @Get('stats/:eventId')
  getStats(@Param('eventId') eventId: string) {
    return this.checkInService.getEventCheckInStats(eventId);
  }
}
