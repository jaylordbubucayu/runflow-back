import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CheckIn } from './entities/check-in.entity';
import { Registration } from '../registrations/entities/registration.entity';
import { RegistrationStatus } from '../common/enums';
import { QrService } from '../common/services/qr.service';

type QrResolution =
  | { state: 'not_found' }
  | { state: 'already_checked_in'; registration: Registration }
  | { state: 'ready'; registration: Registration };

@Injectable()
export class CheckInService {
  constructor(
    @InjectRepository(CheckIn) private readonly checkInsRepo: Repository<CheckIn>,
    @InjectRepository(Registration)
    private readonly registrationsRepo: Repository<Registration>,
    private readonly qrService: QrService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async resolveQr(qrToken: string): Promise<QrResolution> {
    const verified = this.qrService.verify(qrToken);
    if (!verified) return { state: 'not_found' };

    const registration = await this.registrationsRepo.findOne({
      where: { id: verified.registrationId },
      relations: ['event', 'category'],
    });
    if (!registration) return { state: 'not_found' };

    if (registration.status === RegistrationStatus.CHECKED_IN) {
      return { state: 'already_checked_in', registration };
    }
    if (registration.status !== RegistrationStatus.REGISTERED) {
      // e.g. still pending_payment or cancelled - not ready to check in.
      return { state: 'not_found' };
    }
    return { state: 'ready', registration };
  }

  async checkIn(registrationId: string, staffUserId: string) {
    const registration = await this.registrationsRepo.findOne({
      where: { id: registrationId },
    });
    if (!registration) throw new ConflictException('Registration not found');

    const existing = await this.checkInsRepo.findOne({
      where: { registrationId },
    });
    if (existing) {
      throw new ConflictException('Registration already checked in');
    }

    const checkIn = this.checkInsRepo.create({
      registrationId,
      checkedInByUserId: staffUserId,
      checkedInAt: new Date(),
    });
    await this.checkInsRepo.save(checkIn);

    registration.status = RegistrationStatus.CHECKED_IN;
    await this.registrationsRepo.save(registration);

    // Consumed by NotificationsModule (§3).
    this.eventEmitter.emit('registration.checked_in', {
      registrationId,
      userId: registration.runnerUserId,
    });

    return checkIn;
  }

  async getEventCheckInStats(eventId: string) {
    // Everyone who is paid-up for race day: still REGISTERED *or* already
    // CHECKED_IN. Counting REGISTERED alone made checked-in runners drop out
    // of the denominator (1 of 1 checked in reported total=0, 0%).
    const total = await this.registrationsRepo.count({
      where: {
        eventId,
        status: In([
          RegistrationStatus.REGISTERED,
          RegistrationStatus.CHECKED_IN,
        ]),
      },
    });
    const checkedIn = await this.checkInsRepo
      .createQueryBuilder('checkIn')
      .innerJoin('checkIn.registration', 'registration')
      .where('registration.eventId = :eventId', { eventId })
      .getCount();

    const recent = await this.checkInsRepo
      .createQueryBuilder('checkIn')
      .innerJoinAndSelect('checkIn.registration', 'registration')
      .where('registration.eventId = :eventId', { eventId })
      .orderBy('checkIn.checkedInAt', 'DESC')
      .limit(10)
      .getMany();

    return {
      total,
      checkedIn,
      percentage: total > 0 ? Math.round((checkedIn / total) * 100) : 0,
      recent,
    };
  }
}
