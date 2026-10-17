import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole, OrganizationStatus } from '../common/enums';
import { AdminService } from './admin.service';
import { SetFeeConfigDto } from '../payments/dto/set-fee-config.dto';
import { SetOrganizerFeeDto } from '../organizer-fee/dto/set-organizer-fee.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { SetOrganizationStatusDto } from './dto/set-organization-status.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  getDashboard() {
    return this.adminService.getDashboardSummary();
  }

  @Get('revenue')
  getRevenue(
    @Query('range') range: string,
    @Query('groupBy') groupBy: 'event' | 'organizer' | 'time' = 'time',
  ) {
    return this.adminService.getRevenueAnalytics(range, groupBy);
  }

  @Get('organizations')
  listOrganizations(@Query('status') status?: OrganizationStatus) {
    return this.adminService.listOrganizations({ status });
  }

  // Previously ignored the request and always set SUSPENDED, so pending
  // organizations could never be approved. Now honours { status }.
  @Patch('organizations/:id/status')
  setOrganizationStatus(
    @Param('id') id: string,
    @Body() dto: SetOrganizationStatusDto,
  ) {
    return this.adminService.setOrganizationStatus(id, dto.status);
  }

  @Get('events')
  listEvents() {
    return this.adminService.listEvents();
  }

  @Get('registrations')
  listRegistrations() {
    return this.adminService.listRegistrations();
  }

  @Get('users')
  listUsers(@Query('role') role?: string, @Query('isActive') isActive?: string) {
    return this.adminService.listUsers({
      role,
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
  }

  @Get('fee-config')
  getFeeConfig(@Query('organizationId') organizationId?: string) {
    return this.adminService.getFeeConfig(organizationId);
  }

  @Put('fee-config')
  setFeeConfig(@Body() dto: SetFeeConfigDto) {
    return this.adminService.setFeeConfig(dto);
  }

  // The fee ORGANIZERS pay to publish an event (separate from the runner-side fee above).
  @Get('organizer-event-fee')
  getOrganizerEventFee() {
    return this.adminService.getOrganizerEventFee();
  }

  @Put('organizer-event-fee')
  setOrganizerEventFee(@CurrentUser() user: User, @Body() dto: SetOrganizerFeeDto) {
    return this.adminService.setOrganizerEventFee(dto, user.id);
  }

  // Payments that took money the system could not apply cleanly (duplicate / mismatch / late).
  @Get('payments/reconciliation')
  getReconciliation() {
    return this.adminService.getReconciliationQueue();
  }

  @Get('transactions')
  getTransactions(@Query() filters: any) {
    return this.adminService.getTransactions(filters);
  }
}