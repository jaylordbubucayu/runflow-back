import {
  Body,
  Controller,
  Delete,
  Get,
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
import { EventsService } from './events.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { CreateEventCategoryDto } from './dto/create-event-category.dto';
import { UpdateEventCategoryDto } from './dto/update-event-category.dto';
import { SetCategoryRouteDto } from './dto/set-category-route.dto';
import { SetCheckpointDto } from './dto/set-checkpoint.dto';
import { SetPrizeDto } from './dto/set-prize.dto';
import { SetFreebieDto } from './dto/set-freebie.dto';
import { SearchEventsDto } from './dto/search-events.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { User } from '../users/entities/user.entity';
import { ValidateCouponDto } from './dto/validate-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { OrganizationOwnerGuard } from '../auth/guards/organization-owner.guard';

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  // NOTE: organizationId resolution (current organizer's org) is assumed to
  // come off the authenticated user via OrganizationsService in a real
  // implementation; simplified here to keep this controller focused.

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post()
  async create(@CurrentUser() user: User, @Body() dto: CreateEventDto) {
    // Was previously passing the raw user id as the organizationId, which
    // is a different bigint than the organizer's actual Organization row —
    // every event created this way had an organizationId that could never
    // match any real organization, silently breaking OrganizationOwnerGuard
    // on every subsequent management call for that event.
    const org = await this.organizationsService.getByOwner(user.id);
    return this.eventsService.createDraft(org.id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Get('mine')
  async getMine(@CurrentUser() user: User) {
    const org = await this.organizationsService.getByOwner(user.id);
    return this.eventsService.findMine(org.id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.updateDraft(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/categories')
  addCategory(
    @Param('id') eventId: string,
    @Body() dto: CreateEventCategoryDto,
  ) {
    return this.eventsService.addCategory(eventId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch('categories/:categoryId')
  updateCategory(
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdateEventCategoryDto,
  ) {
    return this.eventsService.updateCategory(categoryId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Delete('categories/:categoryId')
  removeCategory(@Param('categoryId') categoryId: string) {
    return this.eventsService.removeCategory(categoryId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post('categories/:categoryId/route')
  setCategoryRoute(
    @Param('categoryId') categoryId: string,
    @Body() dto: SetCategoryRouteDto,
  ) {
    return this.eventsService.setCategoryRoute(categoryId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/checkpoints')
  setCheckpoints(
    @Param('id') eventId: string,
    @Body() checkpoints: SetCheckpointDto[],
  ) {
    return this.eventsService.setCheckpoints(
      eventId,
      checkpoints as unknown as Array<Partial<import('./entities/event-checkpoint.entity').EventCheckpoint>>,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/prizes')
  setPrizes(@Param('id') eventId: string, @Body() prizes: SetPrizeDto[]) {
    return this.eventsService.setPrizes(eventId, prizes);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/freebies')
  setFreebies(
    @Param('id') eventId: string,
    @Body() freebies: SetFreebieDto[],
  ) {
    return this.eventsService.setFreebies(eventId, freebies);
  }

  // OrganizationOwnerGuard added: publishing is now payment-gated, so only the owning
  // organizer may trigger it.
  @UseGuards(JwtAuthGuard, RolesGuard, OrganizationOwnerGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/publish')
  publish(@Param('id') eventId: string) {
    return this.eventsService.publish(eventId);
  }

  // Everything AFTER publish: close registration, mark completed, cancel, or reopen. draft ->
  // reg_open only happens via /publish (above), which has its own prerequisites — this endpoint
  // rejects that specific transition and points callers back at /publish instead.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch(':id/status')
  updateStatus(
    @Param('id') eventId: string,
    @Body() dto: UpdateEventStatusDto,
  ) {
    return this.eventsService.updateStatus(eventId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/unpublish')
  unpublish(@Param('id') eventId: string) {
    return this.eventsService.unpublish(eventId);
  }

  @Get()
  search(@Query() filters: SearchEventsDto) {
    return this.eventsService.search(filters);
  }

  @Get(':id')
  getDetail(@Param('id') id: string) {
    return this.eventsService.getPublicDetail(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Get(':id/overview')
  getOverview(@Param('id') id: string) {
    return this.eventsService.getOverviewStats(id);
  }

    @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Get(':id/coupons')
  listCoupons(@Param('id') eventId: string) {
    return this.eventsService.listCoupons(eventId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post(':id/coupons')
  createCoupon(@Param('id') eventId: string, @Body() dto: CreateCouponDto) {
    return this.eventsService.createCoupon(eventId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch('coupons/:couponId')
  updateCoupon(@Param('couponId') couponId: string, @Body() dto: UpdateCouponDto) {
    return this.eventsService.updateCoupon(couponId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Delete('coupons/:couponId')
  deleteCoupon(@Param('couponId') couponId: string) {
    return this.eventsService.deleteCoupon(couponId);
  }

  // Public/no-auth: lets the registration form show "10% off" before final submit, without
  // consuming a use. Guests (no account) need this to work too.
  @Post(':id/coupons/validate')
  validateCoupon(@Param('id') eventId: string, @Body() dto: ValidateCouponDto) {
    return this.eventsService.previewCoupon(eventId, dto.code, dto.categoryId, dto.email);
  }
}