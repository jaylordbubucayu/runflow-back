import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Registration } from './entities/registration.entity';
import { User } from '../users/entities/user.entity';
import { RunnerProfile } from '../users/entities/runner-profile.entity';
import { Event } from '../events/entities/event.entity';
import { EventStatus, RegistrationStatus, UserRole } from '../common/enums';
import { EventsService } from '../events/events.service';
import { QrService } from '../common/services/qr.service';
import { CreateRegistrationDto } from './dto/create-registration.dto';
import { CreateGuestRegistrationsDto } from './dto/create-guest-registrations.dto';
import { PaymentsService } from '../payments/payments.service';
import { EmailService } from 'src/email/email.service';
import { ConfigService } from '@nestjs/config';
import { Result } from 'src/results/entities/result.entity';

// Each distance prefix owns a block of numbers: 5K -> 5001..5999, 10K -> 10001..10999, etc.
const BIB_BLOCK_SIZE = 1000;
// Used when a category name has no number in it (e.g. "Kids Run"): 9001, 9002, ...
const BIB_FALLBACK_PREFIX = 9;

@Injectable()
export class RegistrationsService {
  private readonly logger = new Logger(RegistrationsService.name);

  constructor(
    @InjectRepository(Registration)
    private readonly registrationsRepo: Repository<Registration>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(RunnerProfile)
    private readonly runnerProfilesRepo: Repository<RunnerProfile>,
    private readonly eventsService: EventsService,
    private readonly qrService: QrService,
    @Inject(forwardRef(() => PaymentsService))
    private readonly paymentsService: PaymentsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  private generateRegistrationCode(): string {
    return `RF-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  async startRegistration(userId: string, dto: CreateRegistrationDto) {
    const category = await this.eventsService.getCategoryOrFail(dto.categoryId);

    this.assertEventAcceptsRegistrations(category.event.status);

    const now = new Date();
    if (
      now < category.event.registrationStart ||
      now > category.event.registrationEnd
    ) {
      throw new BadRequestException('Registration is not open for this event');
    }

    // Same person, same category, already registered or mid-payment: resume / refuse rather than
    // reserving a second slot. (Different people under one account are still allowed.)
    const duplicate = await this.registrationsRepo
      .createQueryBuilder('r')
      .where('r.runnerUserId = :userId', { userId })
      .andWhere('r.categoryId = :categoryId', { categoryId: dto.categoryId })
      .andWhere('LOWER(r.firstName) = LOWER(:fn) AND LOWER(r.lastName) = LOWER(:ln)', {
        fn: dto.firstName,
        ln: dto.lastName,
      })
      .andWhere('r.birthday = :bd', { bd: dto.birthday })
      .andWhere('r.status != :cancelled', { cancelled: RegistrationStatus.CANCELLED })
      .andWhere('r.groupId IS NULL')
      .getOne();
    if (duplicate) {
      if (duplicate.status === RegistrationStatus.PENDING_PAYMENT) return duplicate;
      throw new ConflictException('You are already registered for this category.');
    }

    // Atomic reserve-on-create (§4.1) - avoids the last-slot race condition.
    const reserved = await this.eventsService.reserveSlot(dto.categoryId);
    if (!reserved) {
      throw new BadRequestException('No slots remaining for this category');
    }

    try {
      const registration = this.registrationsRepo.create({
        registrationCode: this.generateRegistrationCode(),
        eventId: category.eventId,
        categoryId: dto.categoryId,
        runnerUserId: userId,
        firstName: dto.firstName,
        lastName: dto.lastName,
        birthday: dto.birthday,
        gender: dto.gender,
        mobileNumber: dto.mobileNumber,
        email: dto.email,
        address: dto.address,
        emergencyContactName: dto.emergencyContactName,
        emergencyContactNumber: dto.emergencyContactNumber,
        shirtSize: dto.shirtSize,
        status: RegistrationStatus.PENDING_PAYMENT,
      });
      const saved = await this.registrationsRepo.save(registration);

      // Signed but not surfaced to the runner until payment succeeds.
      saved.qrToken = this.qrService.sign(saved.id);
      return this.registrationsRepo.save(saved);
    } catch (err) {
      // Roll back the reservation if registration creation failed.
      await this.eventsService.releaseSlot(dto.categoryId);
      throw err;
    }
  }

  /**
   * Finds or creates the shadow account that owns a guest's registrations, keyed by the contact
   * email they typed in — not each participant's own email, since the person filling the form
   * (a team captain, say) may be registering friends who don't have their own accounts or emails
   * handy. Every existing query that joins on runner_user_id (organizer lists, leaderboard,
   * achievements, notifications) keeps working untouched against this real user row.
   *
   * If that email already belongs to a REAL account (isGuest=false), this refuses rather than
   * silently attaching a stranger's registration to someone else's account — they're told to log
   * in instead.
   */
  private async findOrCreateGuestUser(
    email: string,
    firstName: string,
    lastName: string,
  ): Promise<string> {
    const existing = await this.usersRepo.findOne({ where: { email } });
    if (existing) {
      if (!existing.isGuest) {
        throw new ConflictException(
          'An account already exists for this email. Please log in to register.',
        );
      }
      return existing.id;
    }

    // Unusable password: this account can never log in via the normal password flow. If this
    // guest later wants a real account, that's a separate "claim this guest account" feature,
    // not something this endpoint does.
    const passwordHash = await bcrypt.hash(randomUUID(), 10);
    const user = this.usersRepo.create({
      email,
      passwordHash,
      role: UserRole.RUNNER,
      isGuest: true,
    });
    const savedUser = await this.usersRepo.save(user);

    const profile = this.runnerProfilesRepo.create({
      userId: savedUser.id,
      firstName,
      lastName,
    });
    await this.runnerProfilesRepo.save(profile);

    return savedUser.id;
  }

  /**
   * Registers 1-10 participants for the SAME event in one request, with no account required.
   * Every created registration shares a `groupId`; PaymentsService.createGroupCheckout later
   * looks registrations up by that id to charge them all in one combined payment.
   *
   * All-or-nothing: if any participant's category is full or outside its registration window,
   * every reservation and row already created earlier in this same batch is rolled back, so a
   * group registration never ends up partially succeeded.
   */
  async createGuestBatch(dto: CreateGuestRegistrationsDto): Promise<Registration[]> {
    const runnerUserId = await this.findOrCreateGuestUser(
      dto.contactEmail,
      dto.contactFirstName,
      dto.contactLastName,
    );

    const groupId = randomUUID();
    const reservedCategoryIds: string[] = [];
    const created: Registration[] = [];
    let eventId: string | null = null;

    try {
      for (const participant of dto.participants) {
        const category = await this.eventsService.getCategoryOrFail(
          participant.categoryId,
        );

        // A group registers for ONE race, not a cross-event cart — this also keeps the combined
        // checkout's fee calculation simple (one organization's fee config applies to the whole
        // group) rather than needing to split the payment by organization.
        if (eventId === null) {
          eventId = category.eventId;
        } else if (category.eventId !== eventId) {
          throw new BadRequestException(
            'All participants in one guest registration must be for the same event.',
          );
        }

        this.assertEventAcceptsRegistrations(category.event.status);

        const now = new Date();
        if (
          now < category.event.registrationStart ||
          now > category.event.registrationEnd
        ) {
          throw new BadRequestException(
            `Registration is not open for this event (category "${category.name}")`,
          );
        }

        const reserved = await this.eventsService.reserveSlot(
          participant.categoryId,
        );
        if (!reserved) {
          throw new BadRequestException(
            `No slots remaining for category "${category.name}"`,
          );
        }
        reservedCategoryIds.push(participant.categoryId);

        const registration = this.registrationsRepo.create({
          registrationCode: this.generateRegistrationCode(),
          eventId: category.eventId,
          categoryId: participant.categoryId,
          runnerUserId,
          firstName: participant.firstName,
          lastName: participant.lastName,
          birthday: participant.birthday,
          gender: participant.gender,
          mobileNumber: participant.mobileNumber,
          email: participant.email,
          address: participant.address,
          emergencyContactName: participant.emergencyContactName,
          emergencyContactNumber: participant.emergencyContactNumber,
          shirtSize: participant.shirtSize,
          status: RegistrationStatus.PENDING_PAYMENT,
          groupId,
        });
        const saved = await this.registrationsRepo.save(registration);
        saved.qrToken = this.qrService.sign(saved.id);
        created.push(await this.registrationsRepo.save(saved));
      }

      return created;
    } catch (err) {
      // All-or-nothing: undo every slot reservation AND delete every row this batch created so
      // far, rather than leaving a partial, un-payable group behind.
      for (const categoryId of reservedCategoryIds) {
        await this.eventsService.releaseSlot(categoryId);
      }
      if (created.length) {
        await this.registrationsRepo.delete(created.map((r) => r.id));
      }
      throw err;
    }
  }

  async getReviewSummary(registrationId: string) {
    const registration = await this.findOrFail(registrationId);
    const category = await this.eventsService.getCategoryOrFail(
      registration.categoryId,
    );
    const fee = await this.paymentsService.calculateFee(
      Number(category.price),
      category.event.organizationId,
    );

    // Uses the repo's own entity manager, so RegistrationsModule needs no changes.
    const result = await this.registrationsRepo.manager.findOne(Result, {
      where: { registrationId },
    });

    return {
      registration,
      ...fee,
      // true once the results import has marked this registration as completed
      completed: registration.status === RegistrationStatus.COMPLETED,
      // true when the runner has an overall place
      hasPlace: result?.overallRank != null,
      result: result
        ? {
            officialTime: result.officialTime,
            chipTime: result.chipTime,
            gunTime: result.gunTime,
            pacePerKm: result.pacePerKm,
            distanceKm: result.distanceKm,
            overallRank: result.overallRank,
            categoryRank: result.categoryRank,
            ageGroupRank: result.ageGroupRank,
            publishedAt: result.publishedAt,
          }
        : null,
    };
  }

  async cancel(registrationId: string) {
    const registration = await this.findOrFail(registrationId);
    if (registration.status === RegistrationStatus.CANCELLED) {
      return registration;
    }
    registration.status = RegistrationStatus.CANCELLED;
    await this.registrationsRepo.save(registration);
    await this.eventsService.releaseSlot(registration.categoryId);
    // Stop any still-payable PayMongo link for this registration (best effort).
    try {
      await this.paymentsService.onRegistrationCancelled(registrationId);
    } catch (err) {
      this.logger.warn(`Could not cancel pending payment for ${registrationId}: ${(err as Error).message}`);
    }
    return registration;
  }

  /**
   * A payment landed for a registration that had been cancelled/expired. Re-take a slot if one is
   * free and put the registration back to PENDING_PAYMENT so markPaid can confirm it. Returns
   * false (nothing changed) when the category is full — the caller flags the payment for refund.
   */
  async reviveForLatePayment(registrationId: string, manager?: Repository<Registration>): Promise<boolean> {
    const repo = manager ?? this.registrationsRepo;
    const reg = await repo.findOne({ where: { id: registrationId } });
    if (!reg || reg.status !== RegistrationStatus.CANCELLED) return false;
    if (!(await this.eventsService.reserveSlot(reg.categoryId))) return false;
    reg.status = RegistrationStatus.PENDING_PAYMENT;
    await repo.save(reg);
    return true;
  }

  private assertEventAcceptsRegistrations(status: EventStatus) {
    if (status !== EventStatus.REG_OPEN && status !== EventStatus.PUBLISHED) {
      throw new BadRequestException('Registration is not open for this event');
    }
  }

  // Called by PaymentsService inside a transaction once the webhook confirms payment.
  async markPaid(registrationId: string, manager?: Repository<Registration>) {
    const repo = manager ?? this.registrationsRepo;
    const registration = await repo.findOne({ where: { id: registrationId } });
    if (!registration) throw new NotFoundException('Registration not found');

    if (registration.status !== RegistrationStatus.PENDING_PAYMENT) {
      return registration; // idempotent no-op on retried webhook
    }

    // Bib is only handed out once payment is confirmed, so abandoned PENDING_PAYMENT
    // registrations never burn a number or leave gaps.
    registration.bibNumber =
      registration.bibNumber ?? (await this.assignBibNumber(repo, registration));
    registration.status = RegistrationStatus.REGISTERED;
    registration.registeredAt = new Date();
    const saved = await repo.save(registration);

    this.sendConfirmationEmail(saved);
    return saved;
  }

  /**
   * Fire-and-forget: a failed email must never fail the payment webhook.
   * Uses the in-memory registration, so it doesn't re-read the row the
   * surrounding transaction may not have committed yet.
   */
  private sendConfirmationEmail(registration: Registration) {
    if (!registration.email) return;

    void (async () => {
      try {
        const category = await this.eventsService.getCategoryOrFail(registration.categoryId);
        const event = category.event;
        const appName = this.configService.get<string>('APP_NAME') ?? 'Runflow';

        await this.emailService.sendTemplate({
          to: registration.email,
          subject: `You're registered: ${event.name}`,
          template: 'registration-confirmation',
          context: {
            appName,
            firstName: registration.firstName,
            eventName: event.name,
            eventDate: this.formatEventDate(event.eventDate),
            categoryName: category.name,
            registrationCode: registration.registrationCode,
            bibNumber: registration.bibNumber,
          },
          metadata: { event: 'registration-confirmation', registrationId: registration.id },
        });
      } catch (err) {
        // Must not throw: this runs detached, so a throw here is an unhandled rejection that can
        // crash the process right after a payment has been taken.
        this.logger.warn(
          `Confirmation email failed for registration ${registration.id}: ${(err as Error).message}`,
        );
      }
    })();
  }

  private formatEventDate(value: Date | string | null | undefined): string {
    if (!value) return '';
    return new Date(value).toLocaleDateString('en-US', {
      dateStyle: 'full',
      timeZone: 'UTC', // eventDate is a calendar date, so avoid shifting it by timezone
    });
  }

  /**
   * "5K" -> 5, "10K Run" -> 10, "Half Marathon 21K" -> 21. Prefers a number directly before a
   * "K"; otherwise falls back to the first number in the name. Returns the fallback prefix when
   * the name has no digits, so a webhook never fails just because of an oddly named category.
   */
  private getBibPrefix(categoryName: string): number {
    const km = categoryName.match(/(\d+)\s*k/i) ?? categoryName.match(/(\d+)/);
    if (km) return parseInt(km[1], 10);
    this.logger.warn(
      `Category "${categoryName}" has no number in its name; using bib prefix ${BIB_FALLBACK_PREFIX}`,
    );
    return BIB_FALLBACK_PREFIX;
  }

  /**
   * Next bib for this registration's category: 5K -> 5001, 5002...; 10K -> 10001, 10002...
   *
   * Concurrency: locks the EVENT row (pessimistic_write) so two simultaneous payments in the same
   * event can't read the same "max" and hand out the same number. The lock is held until the
   * surrounding transaction commits. If markPaid wasn't given a transactional repo, this opens its
   * own short transaction instead. The unique index on (event_id, bib_number) is the final
   * safety net.
   *
   * Categories sharing a prefix (e.g. "5K Men" and "5K Women") share one sequence, so their
   * bibs never overlap. Bibs outside this prefix's block (like old 1001-style numbers) are
   * ignored when finding the next one.
   */
  private async assignBibNumber(
    repo: Repository<Registration>,
    registration: Registration,
  ): Promise<string> {
    const category = await this.eventsService.getCategoryOrFail(registration.categoryId);
    const base = this.getBibPrefix(category.name) * BIB_BLOCK_SIZE; // 5 -> 5000, 10 -> 10000

    const run = async (em: EntityManager): Promise<string> => {
      await em.findOne(Event, {
        where: { id: registration.eventId },
        lock: { mode: 'pessimistic_write' },
      });

      const row = await em
        .createQueryBuilder(Registration, 'r')
        .select('MAX(CAST(r.bib_number AS UNSIGNED))', 'max')
        .where('r.event_id = :eventId', { eventId: registration.eventId })
        .andWhere('r.bib_number IS NOT NULL')
        .andWhere('CAST(r.bib_number AS UNSIGNED) > :low', { low: base })
        .andWhere('CAST(r.bib_number AS UNSIGNED) < :high', { high: base + BIB_BLOCK_SIZE })
        .getRawOne<{ max: string | null }>();

      const next = row?.max ? Number(row.max) + 1 : base + 1;
      if (next >= base + BIB_BLOCK_SIZE) {
        this.logger.warn(
          `Bib block ${base + 1}-${base + BIB_BLOCK_SIZE - 1} is full for event ${registration.eventId}; issuing ${next}`,
        );
      }

      const bib = String(next);
      // Persist inside the lock so the next payment sees it as soon as the lock is released.
      await em.update(Registration, { id: registration.id }, { bibNumber: bib });
      return bib;
    };

    const em = repo.manager;
    if (em.queryRunner?.isTransactionActive) {
      return run(em);
    }
    return em.transaction(run);
  }

  async getMyRegistrations(
    userId: string,
    scope: 'today' | 'upcoming' | 'past' = 'upcoming',
  ) {
    const qb = this.registrationsRepo
      .createQueryBuilder('registration')
      .leftJoinAndSelect('registration.event', 'event')
      .leftJoinAndSelect('registration.category', 'category')
      .where('registration.runnerUserId = :userId', { userId });

    const today = new Date().toISOString().slice(0, 10);
    if (scope === 'today') {
      qb.andWhere('event.eventDate = :today', { today });
    } else if (scope === 'upcoming') {
      qb.andWhere('event.eventDate >= :today', { today });
    } else {
      qb.andWhere('event.eventDate < :today', { today });
    }

    return qb.orderBy('event.eventDate', 'ASC').getMany();
  }

  async getRacePass(registrationId: string) {
    const registration = await this.registrationsRepo.findOne({
      where: { id: registrationId },
      relations: ['event', 'category'],
    });
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.status === RegistrationStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Registration is not paid yet');
    }
    return registration;
  }

  async findOrFail(registrationId: string) {
    const registration = await this.registrationsRepo.findOne({
      where: { id: registrationId },
    });
    if (!registration) throw new NotFoundException('Registration not found');
    return registration;
  }

  getRepository() {
    return this.registrationsRepo;
  }
}