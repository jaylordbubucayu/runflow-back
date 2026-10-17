import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between, Brackets } from 'typeorm';
import { Event } from './entities/event.entity';
import { EventCategory } from './entities/event-category.entity';
import { EventPrize } from './entities/event-prize.entity';
import { EventFreebie } from './entities/event-freebie.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { EventStatus } from '../common/enums';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateEventStatusDto } from './dto/update-event-status.dto';
import { CreateEventCategoryDto } from './dto/create-event-category.dto';
import { UpdateEventCategoryDto } from './dto/update-event-category.dto';
import { SetCategoryRouteDto } from './dto/set-category-route.dto';
import { SetPrizeDto } from './dto/set-prize.dto';
import { SetFreebieDto } from './dto/set-freebie.dto';
import { SearchEventsDto } from './dto/search-events.dto';
import { EventCoupon } from './entities/event-coupon.entity';
import { CouponDiscountType } from '../common/enums';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { Registration } from 'src/registrations/entities/registration.entity';
import { OrganizerFeeService } from '../organizer-fee/organizer-fee.service';

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(Event) private readonly eventsRepo: Repository<Event>,
    @InjectRepository(EventCategory)
    private readonly categoriesRepo: Repository<EventCategory>,
    @InjectRepository(EventPrize)
    private readonly prizesRepo: Repository<EventPrize>,
    @InjectRepository(EventFreebie)
    private readonly freebiesRepo: Repository<EventFreebie>,
    @InjectRepository(EventCheckpoint)
    private readonly checkpointsRepo: Repository<EventCheckpoint>,
    private readonly dataSource: DataSource,
    @InjectRepository(EventCoupon)
    private readonly couponsRepo: Repository<EventCoupon>,
    @InjectRepository(Registration) private readonly registrationsRepo: Repository<Registration>,
    private readonly organizerFees: OrganizerFeeService,
  ) {}

  // bannerUrl (singular) is what every existing display component reads; bannerUrls (up to 3,
  // from POST /uploads/images) is the source of truth once the organizer has uploaded images.
  // Deriving bannerUrl = bannerUrls[0] here means callers only ever need to send bannerUrls.
  private withPrimaryBanner<T extends { bannerUrl?: string | null; bannerUrls?: string[] | null }>(
    dto: T,
  ): T {
    if (dto.bannerUrls !== undefined) {
      return { ...dto, bannerUrl: dto.bannerUrls?.[0] ?? null };
    }
    return dto;
  }

  // --- Step 1: Basic information ---
  async createDraft(organizationId: string, dto: CreateEventDto) {
    const event = this.eventsRepo.create({
      organizationId,
      ...this.withPrimaryBanner(dto),
      status: EventStatus.DRAFT,
    });
    return this.eventsRepo.save(event);
  }

  async updateDraft(eventId: string, dto: UpdateEventDto) {
    const event = await this.findOrFail(eventId);
    if (event.status !== EventStatus.DRAFT) {
      throw new BadRequestException('Only draft events can be edited here');
    }
    await this.eventsRepo.update(eventId, this.withPrimaryBanner(dto));
    return this.findOrFail(eventId);
  }

  // --- Step 2: Categories ---
  // imageUrl is the category photo, uploaded beforehand through POST /uploads/images.
  // It is separate from routeImageUrl (the route map, set in setCategoryRoute).
  async addCategory(eventId: string, dto: CreateEventCategoryDto) {
    await this.findOrFail(eventId);
    const category = this.categoriesRepo.create({
      eventId,
      ...dto,
      slotsRemaining: dto.slotsTotal,
    } as any);
    return this.categoriesRepo.save(category);
  }

  // Pass imageUrl to change the photo, or imageUrl: null to remove it. Omitting it leaves
  // the current photo untouched (TypeORM's update() skips undefined fields).
  async updateCategory(categoryId: string, dto: UpdateEventCategoryDto) {
    await this.categoriesRepo.update(categoryId, dto as any);
    const category = await this.categoriesRepo.findOne({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async removeCategory(categoryId: string) {
    await this.categoriesRepo.delete(categoryId);
    return { deleted: true };
  }

  // --- Step 3: Route (P0 image/description/distance; checkpoints are P1) ---
  // Each category has its own full route now — see EventCategory entity for why.
  async setCategoryRoute(categoryId: string, dto: SetCategoryRouteDto) {
    const category = await this.categoriesRepo.findOne({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (dto.routeCoordinates) {
      const ok =
        dto.routeCoordinates.length >= 2 &&
        dto.routeCoordinates.every(
          (pt) =>
            Array.isArray(pt) &&
            pt.length === 2 &&
            pt.every((n) => typeof n === 'number' && Number.isFinite(n)),
        );
      if (!ok) {
        throw new BadRequestException(
          'routeCoordinates must be an array of at least 2 [lng, lat] pairs',
        );
      }
    }
    await this.categoriesRepo.update(categoryId, {
      routeImageUrl: dto.imageUrl,
      routeDescription: dto.description,
      routeDistanceKm: dto.distanceKm as any,
      routeElevationM: dto.elevationM,
      routeCoordinates: dto.routeCoordinates as any,
    });
    const updated = await this.categoriesRepo.findOne({
      where: { id: categoryId },
    });
    if (!updated) throw new NotFoundException('Category not found');
    return updated;
  }

  async addCheckpoint(
    eventId: string,
    dto: Partial<EventCheckpoint>,
  ) {
    await this.findOrFail(eventId);
    const checkpoint = this.checkpointsRepo.create({ eventId, ...dto });
    return this.checkpointsRepo.save(checkpoint);
  }

  /**
   * Bulk-replace all checkpoints for an event, mirroring the same
   * replace-the-whole-list pattern already used by setPrizes/setFreebies —
   * this is what the frontend's route/stops map editor calls whenever the
   * organizer adds, drags, or removes a stop.
   */
  async setCheckpoints(
    eventId: string,
    checkpoints: Array<Partial<EventCheckpoint>>,
  ) {
    await this.findOrFail(eventId);
    await this.checkpointsRepo.delete({ eventId });
    if (!checkpoints.length) return [];
    // Array bodies bypass ValidationPipe, so pick known fields explicitly -
    // otherwise a client-supplied `id`/`eventId` in a row could overwrite
    // rows belonging to another event.
    const entities = checkpoints.map((c) =>
      this.checkpointsRepo.create({
        eventId,
        type: c.type,
        name: c.name,
        sequenceOrder: c.sequenceOrder,
        lat: c.lat,
        lng: c.lng,
      }),
    );
    return this.checkpointsRepo.save(entities);
  }

  /** All of an organizer's own events, any status (draft included) — unlike
   * `search()`, which is public discovery and only shows REG_OPEN/PUBLISHED. */
  async findMine(organizationId: string) {
    return this.eventsRepo.find({
      where: { organizationId },
      relations: ['categories', 'prizes', 'freebies', 'checkpoints'],
      order: { createdAt: 'DESC' },
    });
  }

  async setPrizes(eventId: string, prizes: SetPrizeDto[]) {
    await this.findOrFail(eventId);
    // Replace-the-whole-list semantics (delete + insert, atomically). This
    // previously only inserted, so every re-save duplicated all rows.
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EventPrize);
      await repo.delete({ eventId });
      if (!prizes.length) return [];
      // Array bodies bypass ValidationPipe: whitelist fields explicitly.
      const entities = prizes.map((p) =>
        repo.create({
          eventId,
          categoryId: p.categoryId,
          position: p.position,
          amount: p.amount,
          description: p.description,
        } as unknown as Partial<EventPrize>),
      );
      return repo.save(entities);
    });
  }

  // --- Step 5: Freebies ---
  async setFreebies(eventId: string, freebies: SetFreebieDto[]) {
    await this.findOrFail(eventId);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EventFreebie);
      await repo.delete({ eventId });
      if (!freebies.length) return [];
      const entities = freebies.map((f) =>
        repo.create({ eventId, name: f.name, isCustom: f.isCustom }),
      );
      return repo.save(entities);
    });
  }

  // --- Step 6/7: Review -> Publish ---
  /**
   * The prerequisites for going live (categories + routes). Shared by publish() and by the
   * organizer fee checkout, so an organizer is never asked to pay for an event that could not
   * be published anyway.
   */
  async assertReadyToPublish(eventId: string) {
    const event = await this.eventsRepo.findOne({
      where: { id: eventId },
      relations: ['categories'],
    });
    if (!event) throw new NotFoundException('Event not found');

    if (!event.categories?.length) {
      throw new BadRequestException(
        'At least one category is required before publishing',
      );
    }
    // Each category needs its own route now (image OR a drawn path of >= 2 points) — there is
    // no single event-level route to fall back on.
    const categoryMissingRoute = event.categories.some(
      (c) => !c.routeImageUrl && (c.routeCoordinates?.length ?? 0) < 2,
    );
    if (categoryMissingRoute) {
      throw new BadRequestException(
        'Every category needs a route before publishing',
      );
    }
    return event;
  }

  async publish(eventId: string) {
    const event = await this.assertReadyToPublish(eventId);
    // The organizer platform fee (if one is configured) must be VERIFIED paid by PayMongo.
    // Publishing stays a deliberate organizer action: paying never publishes by itself.
    await this.organizerFees.assertSatisfied(eventId);

    event.status = EventStatus.REG_OPEN;
    return this.eventsRepo.save(event);
  }

  async unpublish(eventId: string) {
  const event = await this.findOrFail(eventId);

  if (![EventStatus.PUBLISHED, EventStatus.REG_OPEN].includes(event.status)) {
    throw new BadRequestException(
      `Only published events can be unpublished (this one is ${event.status}).`,
    );
  }

  // Pulling an event that already has runners would strand them.
  const activeRegistrations = await this.registrationsRepo
    .createQueryBuilder('r')
    .where('r.eventId = :eventId', { eventId })
    .andWhere("r.status != 'cancelled'")
    .getCount();
  if (activeRegistrations > 0) {
    throw new BadRequestException(
      'This event already has registrations and can no longer be unpublished.',
    );
  }

  await this.eventsRepo.update(eventId, { status: EventStatus.DRAFT });
  return this.findOrFail(eventId);
}

  // --- Public discovery ---
  async search(filters: SearchEventsDto) {
    const qb = this.eventsRepo
      .createQueryBuilder('event')
      .leftJoinAndSelect('event.categories', 'category')
      .where('event.status IN (:...statuses)', {
        statuses: [EventStatus.REG_OPEN, EventStatus.PUBLISHED],
      });

    if (filters.dateFrom && filters.dateTo) {
      qb.andWhere('event.eventDate BETWEEN :from AND :to', {
        from: filters.dateFrom,
        to: filters.dateTo,
      });
    }
    if (filters.location) {
      qb.andWhere('event.location LIKE :location', {
        location: `%${filters.location}%`,
      });
    }
    if (filters.distanceKm) {
      qb.andWhere('category.distanceKm = :distanceKm', {
        distanceKm: filters.distanceKm,
      });
    }
    if (filters.priceType === 'free') {
      qb.andWhere('category.price = 0');
    } else if (filters.priceType === 'paid') {
      qb.andWhere('category.price > 0');
    }

    return qb.getMany();
  }

  async getPublicDetail(eventId: string) {
    const now = new Date();

    const [event, activeCoupons] = await Promise.all([
      this.eventsRepo
        .createQueryBuilder('event')
        .leftJoin('event.organization', 'org')
        .addSelect([
          'org.id',
          'org.name',
          'org.logoUrl',
          'org.description',
          'org.website',
          'org.socialLinks',
          'org.contactEmail',
          'org.contactNumber',
        ])
        .leftJoinAndSelect('event.categories', 'categories')
        .leftJoinAndSelect('event.prizes', 'prizes')
        .leftJoinAndSelect('event.freebies', 'freebies')
        .leftJoinAndSelect('event.checkpoints', 'checkpoints')
        .where('event.id = :eventId', { eventId })
        .getOne(),

      this.couponsRepo
        .createQueryBuilder('c')
        .select([
          'c.id',
          'c.discountType',
          'c.discountValue',
          'c.validFrom',
          'c.validUntil',
          'c.isActive',
        ])
        .where('c.eventId = :eventId', { eventId })
        .andWhere('c.isActive = :active', { active: true })
        .andWhere(new Brackets((qb) => qb.where('c.validFrom IS NULL').orWhere('c.validFrom <= :now', { now })))
        .andWhere(new Brackets((qb) => qb.where('c.validUntil IS NULL').orWhere('c.validUntil >= :now', { now })))
        .andWhere(new Brackets((qb) => qb.where('c.maxUses IS NULL').orWhere('c.usesCount < c.maxUses')))
        .orderBy('c.createdAt', 'DESC')
        .getMany(),
    ]);

    if (!event) throw new NotFoundException('Event not found');

    const coupons = activeCoupons.map((c) => ({
      id: c.id,
      discountType: c.discountType,
      discountValue: c.discountValue,
      validUntil: c.validUntil,
      isActive: c.isActive,
    }));

    return { ...event, coupons };
  }

  // --- Organizer Overview tab ---
  async getOverviewStats(eventId: string) {
    await this.findOrFail(eventId);

    const raw = await this.dataSource
      .createQueryBuilder()
      .select('COUNT(DISTINCT r.id)', 'totalRegistrations')
      .addSelect(
        `COUNT(DISTINCT CASE WHEN r.status != 'pending_payment' AND r.status != 'cancelled' THEN r.id END)`,
        'paidRegistrations',
      )
      .addSelect(
        `COUNT(DISTINCT CASE WHEN r.status = 'pending_payment' THEN r.id END)`,
        'pendingRegistrations',
      )
      .addSelect('COALESCE(SUM(p.total_amount), 0)', 'grossRevenue')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'platformFees')
      .from('registrations', 'r')
      .leftJoin('payments', 'p', 'p.registration_id = r.id AND p.status = :paid', {
        paid: 'paid',
      })
      .where('r.event_id = :eventId', { eventId })
      .getRawOne();

    return raw;
  }

  private async findOrFail(eventId: string) {
    const event = await this.eventsRepo.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  // Exposed for RegistrationsModule - see §4.1: atomic decrement, no race condition.
  async reserveSlot(categoryId: string): Promise<boolean> {
    const result = await this.categoriesRepo
      .createQueryBuilder()
      .update(EventCategory)
      .set({ slotsRemaining: () => 'slots_remaining - 1' })
      .where('id = :categoryId AND slots_remaining > 0', { categoryId })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async releaseSlot(categoryId: string): Promise<void> {
    await this.categoriesRepo
      .createQueryBuilder()
      .update(EventCategory)
      .set({ slotsRemaining: () => 'slots_remaining + 1' })
      .where('id = :categoryId', { categoryId })
      .execute();
  }

  async getCategoryOrFail(categoryId: string) {
    const category = await this.categoriesRepo.findOne({
      where: { id: categoryId },
      relations: ['event'],
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  // --- Status changes after publish (close registration, mark complete, cancel) ------------
  // draft -> reg_open only happens through publish() above, which has its own prerequisites
  // (categories + routes) — this method deliberately refuses that transition and points callers
  // at /publish instead, so those checks can't be bypassed by going through /status.
  private static readonly ALLOWED_STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
    [EventStatus.DRAFT]: [],
    [EventStatus.PUBLISHED]: [EventStatus.REG_OPEN, EventStatus.CANCELLED],
    [EventStatus.REG_OPEN]: [EventStatus.REG_CLOSED, EventStatus.CANCELLED],
    [EventStatus.REG_CLOSED]: [
      EventStatus.REG_OPEN, // reopen, e.g. the organizer decides to extend registration
      EventStatus.COMPLETED,
      EventStatus.CANCELLED,
    ],
    [EventStatus.COMPLETED]: [], // terminal
    [EventStatus.CANCELLED]: [], // terminal
  };

  async updateStatus(eventId: string, dto: UpdateEventStatusDto) {
    const event = await this.findOrFail(eventId);

    if (dto.status === event.status) {
      return event; // no-op; treat as idempotent rather than an error
    }

    const allowed = EventsService.ALLOWED_STATUS_TRANSITIONS[event.status] ?? [];
    if (!allowed.includes(dto.status)) {
      if (event.status === EventStatus.DRAFT && dto.status === EventStatus.REG_OPEN) {
        throw new BadRequestException(
          'Use POST /events/:id/publish to open registration — it checks that categories and routes are set up first.',
        );
      }
      throw new BadRequestException(
        allowed.length
          ? `Cannot move from ${event.status} to ${dto.status}. Allowed next states: ${allowed.join(', ')}.`
          : `${event.status} is a final state and cannot be changed.`,
      );
    }

    await this.eventsRepo.update(eventId, { status: dto.status });
    return this.findOrFail(eventId);
  }

  // --- Coupons -------------------------------------------------------------------------------

  async listCoupons(eventId: string) {
    return this.couponsRepo.find({ where: { eventId }, order: { createdAt: 'DESC' } });
  }

  async createCoupon(eventId: string, dto: CreateCouponDto) {
    await this.findOrFail(eventId); // 404s if the event doesn't exist
    const existing = await this.couponsRepo.findOne({
      where: { eventId, code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new BadRequestException(
        `A coupon with code "${dto.code.toUpperCase()}" already exists for this event.`,
      );
    }
    const coupon = this.couponsRepo.create({
      eventId,
      code: dto.code.toUpperCase(),
      discountType: dto.discountType,
      discountValue: dto.discountValue as any,
      maxUses: dto.maxUses ?? null,
      maxUsesPerUser: dto.maxUsesPerUser ?? 1,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : null,
      validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
    });
    return this.couponsRepo.save(coupon);
  }

  async updateCoupon(couponId: string, dto: UpdateCouponDto) {
    const coupon = await this.couponsRepo.findOne({ where: { id: couponId } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    if (dto.code) coupon.code = dto.code.toUpperCase();
    if (dto.discountType) coupon.discountType = dto.discountType;
    if (dto.discountValue !== undefined) coupon.discountValue = dto.discountValue as any;
    if (dto.maxUses !== undefined) coupon.maxUses = dto.maxUses ?? null;
    if (dto.maxUsesPerUser !== undefined) coupon.maxUsesPerUser = dto.maxUsesPerUser;
    if (dto.validFrom !== undefined) coupon.validFrom = dto.validFrom ? new Date(dto.validFrom) : null;
    if (dto.validUntil !== undefined) coupon.validUntil = dto.validUntil ? new Date(dto.validUntil) : null;
    if (dto.isActive !== undefined) coupon.isActive = dto.isActive;
    return this.couponsRepo.save(coupon);
  }

  async deleteCoupon(couponId: string): Promise<void> {
    await this.couponsRepo.delete(couponId);
  }

  /**
   * Computes what a coupon WOULD discount, for a specific category and participant email,
   * without consuming a use. Used by the public preview endpoint and internally as the first
   * half of redeemCoupon (below) — kept as a separate method so the preview endpoint and the real
   * redemption share one source of truth for the validation rules.
   *
   * Throws BadRequestException with a specific, user-facing reason on any failure — invalid code,
   * expired, exhausted, already used by this email, etc. — rather than a generic "coupon invalid".
   */
  async previewCoupon(
    eventId: string,
    code: string,
    categoryId: string,
    email: string,
  ): Promise<{ coupon: EventCoupon; discountAmount: number }> {
    const coupon = await this.couponsRepo.findOne({
      where: { eventId, code: code.toUpperCase() },
    });
    if (!coupon) throw new BadRequestException('This coupon code is not valid for this event.');
    if (!coupon.isActive) throw new BadRequestException('This coupon is no longer active.');

    const now = new Date();
    if (coupon.validFrom && now < coupon.validFrom) {
      throw new BadRequestException('This coupon is not active yet.');
    }
    if (coupon.validUntil && now > coupon.validUntil) {
      throw new BadRequestException('This coupon has expired.');
    }
    if (coupon.maxUses !== null && coupon.usesCount >= coupon.maxUses) {
      throw new BadRequestException('This coupon has reached its usage limit.');
    }

    // Per-user limit: counted from existing registrations, not a separate redemption log table —
    // every redemption is already recorded on the registration row itself (coupon_id + the
    // participant's own email column).
    const timesUsedByThisEmail = await this.dataSourceCountRegistrationsByCouponAndEmail(
      coupon.id,
      email,
    );
    if (timesUsedByThisEmail >= coupon.maxUsesPerUser) {
      throw new BadRequestException('You have already used this coupon.');
    }

    const category = await this.getCategoryOrFail(categoryId);
    if (category.eventId !== eventId) {
      throw new BadRequestException('This coupon does not apply to that category.');
    }

    const price = Number(category.price);
    const discountAmount =
      coupon.discountType === CouponDiscountType.PERCENTAGE
        ? Math.round(price * (Number(coupon.discountValue) / 100) * 100) / 100
        : Math.min(Number(coupon.discountValue), price); // never discount below zero

    return { coupon, discountAmount };
  }

  // Small private helper used by previewCoupon above. Implemented with a plain repository count
  // rather than a query builder since it's a single straightforward WHERE match.
  private async dataSourceCountRegistrationsByCouponAndEmail(
    couponId: string,
    email: string,
  ): Promise<number> {
    return this.registrationsRepo
      .createQueryBuilder('r')
      .where('r.couponId = :couponId', { couponId })
      .andWhere('LOWER(r.email) = LOWER(:email)', { email })
      .andWhere("r.status != 'cancelled'")
      .getCount();
  }

  /**
   * The real redemption: validates via previewCoupon, then ATOMICALLY increments uses_count only
   * if there's still room — a single conditional UPDATE, not a read-then-write, so two concurrent
   * registrations can't both claim the last use of a capped coupon. Returns null (not an error)
   * if the atomic increment loses the race, so the caller can retry validation or surface a clean
   * "someone just used the last one" message rather than a generic failure.
   */
  async redeemCoupon(
    eventId: string,
    code: string,
    categoryId: string,
    email: string,
  ): Promise<{ couponId: string; couponCode: string; discountAmount: number } | null> {
    const { coupon, discountAmount } = await this.previewCoupon(eventId, code, categoryId, email);

    const result = await this.couponsRepo
      .createQueryBuilder()
      .update(EventCoupon)
      .set({ usesCount: () => 'uses_count + 1' })
      .where('id = :id', { id: coupon.id })
      .andWhere('(max_uses IS NULL OR uses_count < max_uses)')
      .execute();

    if (!result.affected) {
      return null; // lost the race to someone else claiming the last use
    }

    return { couponId: coupon.id, couponCode: coupon.code, discountAmount };
  }

  /** Symmetric with releasing a category slot on cancellation — gives the use back. */
  async releaseCouponUse(couponId: string): Promise<void> {
    await this.couponsRepo
      .createQueryBuilder()
      .update(EventCoupon)
      .set({ usesCount: () => 'GREATEST(uses_count - 1, 0)' })
      .where('id = :id', { id: couponId })
      .execute();
  }
}